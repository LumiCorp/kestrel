#!/usr/bin/env python3
from __future__ import annotations

from argparse import ArgumentParser

from swebench.harness.prepare_images import main as prepare_images_main
from swebench.harness.utils import optional_str, str2bool

from swe_verified_compat import patch_astropy_3x_specs, patch_swebench_image_listing


def main() -> int:
    parser = ArgumentParser()
    parser.add_argument("--dataset_name", type=str, default="SWE-bench/SWE-bench_Lite")
    parser.add_argument("--split", type=str, default="test")
    parser.add_argument("--instance_ids", nargs="+", type=str)
    parser.add_argument("--max_workers", type=int, default=4)
    parser.add_argument("--force_rebuild", type=str2bool, default=False)
    parser.add_argument("--open_file_limit", type=int, default=8192)
    parser.add_argument("--namespace", type=optional_str, default=None)
    parser.add_argument("--tag", type=str, default=None)
    parser.add_argument("--env_image_tag", type=str, default=None)
    args = parser.parse_args()

    patch_astropy_3x_specs()
    patch_swebench_image_listing()
    result = prepare_images_main(**vars(args))
    return 0 if result is None else int(result)


if __name__ == "__main__":
    raise SystemExit(main())
