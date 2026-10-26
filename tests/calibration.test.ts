import { describe, expect, it } from 'vitest';
import {
  calculateBrierScore,
  evaluateCalibration,
  CalibrationTracker,
  type CalibrationRecord,
} from '../server/decision/calibration.js';

describe('Jev Brier Score & Forecast Reliability Calibration', () => {
  it('computes 0.0 Brier score for perfect deterministic forecasts', () => {
    const perfectRecords: CalibrationRecord[] = [
      { id: '1', symbol: 'BTCUSDT', timestamp: 1, forecastProbability: 1.0, realizedOutcome: 1 },
      { id: '2', symbol: 'ETHUSDT', timestamp: 2, forecastProbability: 0.0, realizedOutcome: 0 },
      { id: '3', symbol: 'SOLUSDT', timestamp: 3, forecastProbability: 1.0, realizedOutcome: 1 },
    ];
    expect(calculateBrierScore(perfectRecords)).toBe(0);
  });

  it('computes 0.25 Brier score for completely uninformative 50% coin-flip forecasts', () => {
    const coinFlipRecords: CalibrationRecord[] = [
      { id: '1', symbol: 'BTCUSDT', timestamp: 1, forecastProbability: 0.5, realizedOutcome: 1 },
      { id: '2', symbol: 'ETHUSDT', timestamp: 2, forecastProbability: 0.5, realizedOutcome: 0 },
    ];
    expect(calculateBrierScore(coinFlipRecords)).toBe(0.25);
  });

  it('evaluates calibration quality and constructs reliability bins', () => {
    const records: CalibrationRecord[] = [
      { id: '1', symbol: 'BTCUSDT', timestamp: 1, forecastProbability: 0.85, realizedOutcome: 1 },
      { id: '2', symbol: 'ETHUSDT', timestamp: 2, forecastProbability: 0.80, realizedOutcome: 1 },
      { id: '3', symbol: 'SOLUSDT', timestamp: 3, forecastProbability: 0.20, realizedOutcome: 0 },
      { id: '4', symbol: 'BNBUSDT', timestamp: 4, forecastProbability: 0.15, realizedOutcome: 0 },
      { id: '5', symbol: 'ADAUSDT', timestamp: 5, forecastProbability: 0.90, realizedOutcome: 1 },
    ];

    const report = evaluateCalibration(records, 5);
    expect(report.sampleSize).toBe(5);
    expect(report.brierScore).toBeLessThan(0.10);
    expect(report.calibrationQuality).toBe('WELL_CALIBRATED');
    expect(report.bins.length).toBe(5);
    expect(report.expectedCalibrationError).toBeLessThan(0.20);
  });

  it('CalibrationTracker stores forecasts and yields historical reports', () => {
    const tracker = new CalibrationTracker();
    tracker.recordForecast({ id: '1', symbol: 'BTCUSDT', timestamp: 100, forecastProbability: 0.75, realizedOutcome: 1 });
    tracker.recordForecast({ id: '2', symbol: 'BTCUSDT', timestamp: 200, forecastProbability: 0.30, realizedOutcome: 0 });

    expect(tracker.getRecords().length).toBe(2);
    const report = tracker.getReport(5);
    expect(report.sampleSize).toBe(2);
    expect(report.brierScore).toBeLessThan(0.15);

    tracker.clear();
    expect(tracker.getRecords().length).toBe(0);
  });
});
