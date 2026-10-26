/**
 * Jev Forecast Calibration & Brier Score Evaluation Engine for Mpu Gandring.
 *
 * Implements rigorous quantitative calibration metrics:
 * - Brier Score: Mean squared error of probabilistic forecasts.
 * - Brier Skill Score (BSS): Skill relative to climatological / naive reference.
 * - Reliability Diagram & Calibration Curve: Evaluates systematic over/under-confidence.
 * - Expected Calibration Error (ECE) & Maximum Calibration Error (MCE).
 */

import { recordDiagnostic } from '../session-log.js';

export interface CalibrationRecord {
  id: string;
  symbol: string;
  timestamp: number;
  forecastProbability: number; // 0.0 to 1.0 (e.g. probability of profitable trade)
  realizedOutcome: 0 | 1; // 1 = profitable/win, 0 = loss/breakeven
  context?: string;
}

export interface CalibrationBin {
  binIndex: number;
  minProb: number;
  maxProb: number;
  count: number;
  predictedAvg: number;
  observedFreq: number;
  calibrationError: number;
}

export interface CalibrationReport {
  sampleSize: number;
  brierScore: number;
  brierSkillScore: number;
  expectedCalibrationError: number;
  maximumCalibrationError: number;
  calibrationQuality: 'WELL_CALIBRATED' | 'MODERATE_MISCALIBRATION' | 'POORLY_CALIBRATED';
  bins: CalibrationBin[];
}

/**
 * Calculates raw Brier Score for a series of probabilistic predictions.
 * Range: 0.0 (perfect) to 1.0 (worst possible). 0.25 represents uninformative coin-flip guessing.
 */
export function calculateBrierScore(records: CalibrationRecord[]): number {
  if (records.length === 0) return 0;

  let sum = 0;
  for (const r of records) {
    const error = r.forecastProbability - r.realizedOutcome;
    sum += error * error;
  }

  return Number((sum / records.length).toFixed(4));
}

/**
 * Evaluates forecast reliability and generates empirical calibration bins.
 */
export function evaluateCalibration(
  records: CalibrationRecord[],
  numBins: number = 5,
  referenceRate?: number
): CalibrationReport {
  if (records.length === 0) {
    return {
      sampleSize: 0,
      brierScore: 0,
      brierSkillScore: 0,
      expectedCalibrationError: 0,
      maximumCalibrationError: 0,
      calibrationQuality: 'WELL_CALIBRATED',
      bins: [],
    };
  }

  const brierScore = calculateBrierScore(records);

  // Compute reference Brier score based on sample base rate or supplied baseline
  const baseRate = referenceRate ?? (records.reduce((acc, r) => acc + r.realizedOutcome, 0) / records.length);
  let refSum = 0;
  for (const r of records) {
    const err = baseRate - r.realizedOutcome;
    refSum += err * err;
  }
  const refBrier = records.length > 0 ? (refSum / records.length) : 0.25;
  const brierSkillScore = refBrier > 0 ? Number((1 - (brierScore / refBrier)).toFixed(4)) : 0;

  // Build calibration bins
  const binWidth = 1.0 / numBins;
  const bins: CalibrationBin[] = [];
  let weightedEceSum = 0;
  let maxError = 0;

  for (let i = 0; i < numBins; i++) {
    const minProb = i * binWidth;
    const maxProb = (i === numBins - 1) ? 1.0001 : (i + 1) * binWidth;

    const inBin = records.filter(r => r.forecastProbability >= minProb && r.forecastProbability < maxProb);
    const count = inBin.length;

    if (count === 0) {
      bins.push({
        binIndex: i,
        minProb: Number(minProb.toFixed(2)),
        maxProb: Number(Math.min(1.0, maxProb).toFixed(2)),
        count: 0,
        predictedAvg: Number(((minProb + Math.min(1.0, maxProb)) / 2).toFixed(2)),
        observedFreq: 0,
        calibrationError: 0,
      });
      continue;
    }

    const predictedAvg = inBin.reduce((acc, r) => acc + r.forecastProbability, 0) / count;
    const observedFreq = inBin.reduce((acc, r) => acc + r.realizedOutcome, 0) / count;
    const calibrationError = Math.abs(predictedAvg - observedFreq);

    weightedEceSum += (count / records.length) * calibrationError;
    if (calibrationError > maxError) {
      maxError = calibrationError;
    }

    bins.push({
      binIndex: i,
      minProb: Number(minProb.toFixed(2)),
      maxProb: Number(Math.min(1.0, maxProb).toFixed(2)),
      count,
      predictedAvg: Number(predictedAvg.toFixed(4)),
      observedFreq: Number(observedFreq.toFixed(4)),
      calibrationError: Number(calibrationError.toFixed(4)),
    });
  }

  const expectedCalibrationError = Number(weightedEceSum.toFixed(4));
  const maximumCalibrationError = Number(maxError.toFixed(4));

  let calibrationQuality: 'WELL_CALIBRATED' | 'MODERATE_MISCALIBRATION' | 'POORLY_CALIBRATED';
  if (expectedCalibrationError <= 0.18 && brierScore <= 0.18) {
    calibrationQuality = 'WELL_CALIBRATED';
  } else if (expectedCalibrationError <= 0.28 && brierScore <= 0.25) {
    calibrationQuality = 'MODERATE_MISCALIBRATION';
  } else {
    calibrationQuality = 'POORLY_CALIBRATED';
  }

  return {
    sampleSize: records.length,
    brierScore,
    brierSkillScore,
    expectedCalibrationError,
    maximumCalibrationError,
    calibrationQuality,
    bins,
  };
}

/**
 * In-memory ledger for recording and querying calibration performance.
 */
export class CalibrationTracker {
  private records: CalibrationRecord[] = [];

  constructor(initialRecords: CalibrationRecord[] = []) {
    this.records = [...initialRecords];
  }

  public recordForecast(record: CalibrationRecord): void {
    this.records.push(record);
    recordDiagnostic({ source: 'calibration', category: 'PREDICTION', eventName: 'calibration.recorded', status: 'recorded', correlationId: record.id, message: 'Observed calibration outcome recorded', details: { symbol: record.symbol, forecastProbability: record.forecastProbability, realizedOutcome: record.realizedOutcome } });
  }

  public getRecords(): CalibrationRecord[] {
    return [...this.records];
  }

  public getReport(numBins: number = 5): CalibrationReport {
    return evaluateCalibration(this.records, numBins);
  }

  public clear(): void {
    this.records = [];
  }
}
