#!/usr/bin/env python3
"""Local GBM path simulation worker. It does not run pretrained Kronos inference."""

import sys
import json
import math
import random
from http.server import HTTPServer, BaseHTTPRequestHandler

MAX_HORIZON = 500
MAX_PATHS = 5000


def simulate_paths(candles, horizon=10, num_paths=200, tp_price=None, sl_price=None, seed=None, side="LONG"):
    if not isinstance(horizon, int) or isinstance(horizon, bool) or not 1 <= horizon <= MAX_HORIZON:
        raise ValueError(f"horizon must be an integer from 1 to {MAX_HORIZON}")
    if not isinstance(num_paths, int) or isinstance(num_paths, bool) or not 1 <= num_paths <= MAX_PATHS:
        raise ValueError(f"num_paths must be an integer from 1 to {MAX_PATHS}")
    if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 0xffffffff):
        raise ValueError("seed must be an integer from 0 to 4294967295")
    if side not in ("LONG", "SHORT"):
        raise ValueError("side must be LONG or SHORT")

    closes = []
    for candle in candles or []:
        value = candle.get("c", candle.get("close"))
        try:
            price = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(price) and price > 0:
            closes.append(price)

    current_price = closes[-1] if closes else None
    if len(closes) < 2:
        return {
            "current_price": current_price, "horizon": horizon, "num_paths": num_paths,
            "drift": None, "volatility": None, "regime": "UNCERTAIN",
            "prob_tp_first": None, "prob_sl_first": None, "prob_no_hit": None,
            "expected_return_pct": None, "p10": [], "p50": [], "p90": [],
        }

    returns = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]
    mean_return = sum(returns) / len(returns)
    variance = sum((value - mean_return) ** 2 for value in returns) / max(1, len(returns) - 1)
    volatility = math.sqrt(variance)
    drift = mean_return * 0.8
    rng = random.Random(seed)
    has_barriers = (isinstance(tp_price, (int, float)) and math.isfinite(tp_price) and tp_price > 0
                    and isinstance(sl_price, (int, float)) and math.isfinite(sl_price) and sl_price > 0)
    if has_barriers and (tp_price <= sl_price if side == "LONG" else tp_price >= sl_price):
        raise ValueError(f"tp_price and sl_price are not ordered for a {side} position")
    paths, tp_hits, sl_hits, no_hits = [], 0, 0, 0

    for _ in range(num_paths):
        path = [current_price]
        price = current_price
        first_hit = None
        for _step in range(horizon):
            price *= math.exp(drift - 0.5 * volatility ** 2 + volatility * rng.gauss(0.0, 1.0))
            if not math.isfinite(price) or price <= 0:
                raise ValueError("simulation produced a non-finite or non-positive price")
            path.append(price)
            if first_hit is None and has_barriers:
                tp_hit = price >= tp_price if side == "LONG" else price <= tp_price
                sl_hit = price <= sl_price if side == "LONG" else price >= sl_price
                if tp_hit:
                    first_hit = "TP"
                elif sl_hit:
                    first_hit = "SL"
        if first_hit == "TP":
            tp_hits += 1
        elif first_hit == "SL":
            sl_hits += 1
        else:
            no_hits += 1
        paths.append(path)

    def quantile(values, p):
        values = sorted(values)
        return values[min(len(values) - 1, int(p * len(values)))]

    p10 = [quantile([path[step] for path in paths], 0.1) for step in range(horizon + 1)]
    p50 = [quantile([path[step] for path in paths], 0.5) for step in range(horizon + 1)]
    p90 = [quantile([path[step] for path in paths], 0.9) for step in range(horizon + 1)]
    recent = returns[-5:]
    recent_variance = sum((value - mean_return) ** 2 for value in recent) / max(1, len(recent) - 1)
    recent_volatility = math.sqrt(recent_variance)
    regime = ("EXPANDING_VOLATILITY" if recent_volatility > volatility * 1.3 else
              "CONTRACTING_VOLATILITY" if recent_volatility < volatility * 0.7 else "STABLE_DRIFT")
    expected_return_pct = (p50[-1] - current_price) / current_price * 100
    if not math.isfinite(expected_return_pct):
        return {
            "current_price": current_price, "horizon": horizon, "num_paths": num_paths,
            "drift": None, "volatility": None, "regime": "UNCERTAIN",
            "prob_tp_first": None, "prob_sl_first": None, "prob_no_hit": None,
            "expected_return_pct": None, "p10": [], "p50": [], "p90": [],
        }

    return {
        "current_price": current_price, "horizon": horizon, "num_paths": num_paths,
        "drift": round(drift, 6), "volatility": round(volatility, 6), "regime": regime,
        "prob_tp_first": round(tp_hits / num_paths, 4) if has_barriers else None,
        "prob_sl_first": round(sl_hits / num_paths, 4) if has_barriers else None,
        "prob_no_hit": round(no_hits / num_paths, 4) if has_barriers else None,
        "expected_return_pct": expected_return_pct,
        "p10": p10, "p50": p50, "p90": p90,
    }


class KronosHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "worker": "local-gbm-simulation"}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/predict":
            self.send_response(404)
            self.end_headers()
            return
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(content_length).decode("utf-8"))
            result = simulate_paths(
                data.get("candles", []), data.get("horizon", 10), data.get("num_paths", 200),
                data.get("tp_price"), data.get("sl_price"), data.get("seed"), data.get("side", "LONG"),
            )
            status = 200
        except Exception as exc:
            result, status = {"error": str(exc)}, 400
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(result, allow_nan=False).encode("utf-8"))

    def log_message(self, fmt, *args):
        pass


def run_self_test():
    candles = [{"c": 100 + index * 0.5} for index in range(25)]
    result = simulate_paths(candles, horizon=5, num_paths=100, tp_price=120.0, sl_price=95.0, seed=7)
    assert len(result["p10"]) == len(result["p50"]) == len(result["p90"]) == 6
    assert result["p10"][0] == result["p50"][0] == result["p90"][0] == result["current_price"]
    assert result["p10"][-1] <= result["p50"][-1] <= result["p90"][-1]
    assert abs(result["prob_tp_first"] + result["prob_sl_first"] + result["prob_no_hit"] - 1) < 0.001
    print("PASS: local GBM worker self-test passed.")


if __name__ == "__main__":
    if "--test" in sys.argv:
        run_self_test()
    elif "--serve" in sys.argv:
        port_arg = sys.argv.index("--serve") + 1
        server = HTTPServer(("127.0.0.1", int(sys.argv[port_arg]) if port_arg < len(sys.argv) else 8181), KronosHandler)
        print(f"GBM simulation worker listening on http://127.0.0.1:{server.server_port}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        server.server_close()
    else:
        request = json.loads(sys.stdin.read() or "{}")
        print(json.dumps(simulate_paths(
            request.get("candles", []), request.get("horizon", 10), request.get("num_paths", 200),
            request.get("tp_price"), request.get("sl_price"), request.get("seed"), request.get("side", "LONG"),
        ), allow_nan=False))
