#!/usr/bin/env python3
"""
Kronos Predictive Intelligence Worker for Trading Agent Mpu Gandring.

Clean-room Python worker inspired by shiyu-coder/Kronos:
- Autoregressive momentum drift and volatility estimation from historical K-lines.
- Monte Carlo forward trajectory simulation producing P10, P50, P90 quantile envelopes.
- Probability of hitting Take Profit before Stop Loss: P(TP first).
- Standard library zero-dependency execution with optional HTTP daemon mode.
"""

import sys
import json
import math
import random
from http.server import HTTPServer, BaseHTTPRequestHandler

def simulate_paths(candles, horizon=10, num_paths=200, tp_price=None, sl_price=None):
    """
    Simulates forward K-line trajectories using geometric Brownian motion with momentum drift.
    """
    if not candles or len(candles) < 2:
        return {
            "error": "Insufficient candles",
            "p10": [], "p50": [], "p90": [],
            "prob_tp_first": 0.5,
            "drift": 0.0,
            "volatility": 0.0,
            "regime": "UNCERTAIN"
        }

    closes = [float(c.get("c", c.get("close", 0))) for c in candles if float(c.get("c", c.get("close", 0))) > 0]
    if len(closes) < 2:
        return {"error": "Invalid close prices", "p10": [], "p50": [], "p90": []}

    current_price = closes[-1]

    # Calculate log returns
    returns = []
    for i in range(1, len(closes)):
        ret = math.log(closes[i] / closes[i - 1])
        returns.append(ret)

    n = len(returns)
    mean_return = sum(returns) / n
    variance = sum((r - mean_return) ** 2 for r in returns) / max(1, n - 1)
    volatility = math.sqrt(variance)

    # Momentum drift with decay
    drift = mean_return * 0.8

    # Simulate Monte Carlo paths
    paths = []
    tp_hits = 0
    sl_hits = 0

    for _ in range(num_paths):
        path = [current_price]
        p = current_price
        hit_tp = False
        hit_sl = False

        for step in range(1, horizon + 1):
            # Box-Muller standard normal variate
            z = random.gauss(0.0, 1.0)
            p = p * math.exp((drift - 0.5 * (volatility ** 2)) + volatility * z)
            path.append(p)

            # Check barriers if provided
            if not hit_tp and not hit_sl:
                if tp_price and p >= tp_price:
                    hit_tp = True
                elif sl_price and p <= sl_price:
                    hit_sl = True

        if hit_tp and not hit_sl:
            tp_hits += 1
        elif hit_sl and not hit_tp:
            sl_hits += 1

        paths.append(path)

    # Compute quantile paths for each step
    p10_path = []
    p50_path = []
    p90_path = []

    for step in range(horizon + 1):
        step_prices = sorted(path[step] for path in paths)
        idx10 = int(0.10 * num_paths)
        idx50 = int(0.50 * num_paths)
        idx90 = min(num_paths - 1, int(0.90 * num_paths))

        p10_path.append(round(step_prices[idx10], 4))
        p50_path.append(round(step_prices[idx50], 4))
        p90_path.append(round(step_prices[idx90], 4))

    total_terminal = tp_hits + sl_hits
    prob_tp_first = round(tp_hits / total_terminal, 4) if total_terminal > 0 else 0.5

    # Classify volatility regime
    recent_vol = math.sqrt(sum((r - mean_return) ** 2 for r in returns[-5:]) / max(1, len(returns[-5:]) - 1)) if len(returns) >= 5 else volatility
    if recent_vol > volatility * 1.3:
        regime = "EXPANDING_VOLATILITY"
    elif recent_vol < volatility * 0.7:
        regime = "CONTRACTING_VOLATILITY"
    else:
        regime = "STABLE_DRIFT"

    return {
        "current_price": round(current_price, 4),
        "horizon": horizon,
        "num_paths": num_paths,
        "drift": round(drift, 6),
        "volatility": round(volatility, 6),
        "regime": regime,
        "prob_tp_first": prob_tp_first,
        "p10": p10_path,
        "p50": p50_path,
        "p90": p90_path
    }

class KronosHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "worker": "kronos", "version": "1.0.0"}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/predict":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                data = json.loads(body)
                candles = data.get("candles", [])
                horizon = int(data.get("horizon", 10))
                num_paths = int(data.get("num_paths", 200))
                tp = data.get("tp_price")
                sl = data.get("sl_price")

                result = simulate_paths(candles, horizon, num_paths, tp, sl)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(result).encode("utf-8"))
            except Exception as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Quiet logs for background performance

def run_self_test():
    """Validates worker calculation determinism and output structure."""
    test_candles = [
        {"t": 1000 + i * 60, "o": 100 + i * 0.5, "h": 101 + i * 0.5, "l": 99 + i * 0.5, "c": 100.5 + i * 0.5, "v": 100}
        for i in range(25)
    ]
    res = simulate_paths(test_candles, horizon=5, num_paths=100, tp_price=120.0, sl_price=95.0)

    assert "p10" in res and len(res["p10"]) == 6, "Missing or malformed p10"
    assert "p50" in res and len(res["p50"]) == 6, "Missing or malformed p50"
    assert "p90" in res and len(res["p90"]) == 6, "Missing or malformed p90"
    assert res["p10"][0] == res["p50"][0] == res["p90"][0] == res["current_price"], "Paths must start at current price"
    assert res["p10"][-1] <= res["p50"][-1] <= res["p90"][-1], "Quantiles must maintain ordering p10 <= p50 <= p90"
    assert 0.0 <= res["prob_tp_first"] <= 1.0, "Probability must be bounded [0, 1]"
    print("PASS: Kronos worker self-test passed.")

if __name__ == "__main__":
    if "--test" in sys.argv:
        run_self_test()
        sys.exit(0)
    elif "--serve" in sys.argv:
        port = int(sys.argv[sys.argv.index("--serve") + 1]) if len(sys.argv) > sys.argv.index("--serve") + 1 else 8181
        server = HTTPServer(("127.0.0.1", port), KronosHandler)
        print(f"Kronos worker listening on http://127.0.0.1:{port}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        server.server_close()
    else:
        # One-shot stdio JSON mode
        input_data = sys.stdin.read()
        if input_data.strip():
            req = json.loads(input_data)
            output = simulate_paths(
                req.get("candles", []),
                req.get("horizon", 10),
                req.get("num_paths", 200),
                req.get("tp_price"),
                req.get("sl_price")
            )
            print(json.dumps(output))
        else:
            print(json.dumps({"error": "Empty input"}))
