#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json

from swebench.harness.test_spec.test_spec import make_test_spec
from swebench.harness.utils import load_swebench_dataset


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--split", required=True)
    parser.add_argument("--instance-id", required=True)
    args = parser.parse_args()

    dataset = load_swebench_dataset(args.dataset, args.split)
    for row in dataset:
        if row.get("instance_id") != args.instance_id:
            continue
        spec = make_test_spec(row)
        print(json.dumps({
            "instance_id": spec.instance_id,
            "instance_image_key": spec.instance_image_key,
            "platform": spec.platform,
        }))
        return 0

    raise SystemExit(f"instance not found: {args.instance_id}")


if __name__ == "__main__":
    raise SystemExit(main())
