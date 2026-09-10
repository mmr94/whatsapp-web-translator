from __future__ import annotations

import argparse
import asyncio
import statistics
import time

import httpx


async def main() -> None:
    parser = argparse.ArgumentParser(description="Load-test the translation endpoint")
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--token", default="")
    parser.add_argument("--requests", type=int, default=200)
    parser.add_argument("--concurrency", type=int, default=32)
    parser.add_argument("--source", default="fr")
    parser.add_argument("--target", default="he")
    parser.add_argument("--warmup", type=int, default=10)
    args = parser.parse_args()

    headers = {"Authorization": f"Bearer {args.token}"} if args.token else {}
    semaphore = asyncio.Semaphore(args.concurrency)
    latencies: list[float] = []

    async with httpx.AsyncClient(headers=headers, timeout=120) as client:
        async def request(index: int, measured: bool) -> None:
            async with semaphore:
                started = time.perf_counter()
                response = await client.post(
                    f"{args.url.rstrip('/')}/v1/translate",
                    json={
                        "text": f"Message de test numéro {index}: on se retrouve à 18h30 ?",
                        "source": args.source,
                        "target": args.target,
                    },
                )
                response.raise_for_status()
                if measured:
                    latencies.append((time.perf_counter() - started) * 1000)

        await asyncio.gather(*(request(index, False) for index in range(args.warmup)))
        started = time.perf_counter()
        await asyncio.gather(*(request(index + 10_000, True) for index in range(args.requests)))
        elapsed = time.perf_counter() - started

    ordered = sorted(latencies)

    def percentile(fraction: float) -> float:
        return ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]

    print(f"requests={args.requests} concurrency={args.concurrency}")
    print(f"throughput={args.requests / elapsed:.2f} requests/s")
    print(f"mean={statistics.mean(latencies):.1f} ms")
    print(
        f"p50={percentile(0.50):.1f} ms "
        f"p95={percentile(0.95):.1f} ms "
        f"p99={percentile(0.99):.1f} ms"
    )


if __name__ == "__main__":
    asyncio.run(main())
