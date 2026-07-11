#!/usr/bin/env python3
from __future__ import annotations

from argparse import ArgumentDefaultsHelpFormatter, ArgumentParser

from swebench.harness.run_evaluation import main as run_evaluation_main
from swebench.harness.utils import optional_str, str2bool

from swe_verified_compat import patch_astropy_3x_specs, patch_swebench_image_listing


def main() -> int:
    parser = ArgumentParser(
        description="Run SWE-bench evaluation with Kestrel local compatibility patches.",
        formatter_class=ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("-d", "--dataset_name", default="SWE-bench/SWE-bench_Lite", type=str)
    parser.add_argument("-s", "--split", type=str, default="test")
    parser.add_argument("-i", "--instance_ids", nargs="+", type=str)
    parser.add_argument("-p", "--predictions_path", type=str, required=True)
    parser.add_argument("--max_workers", type=int, default=4)
    parser.add_argument("--open_file_limit", type=int, default=4096)
    parser.add_argument("-t", "--timeout", type=int, default=1800)
    parser.add_argument("--force_rebuild", type=str2bool, default=False)
    parser.add_argument("--cache_level", type=str, choices=["none", "base", "env", "instance"], default="env")
    parser.add_argument("--clean", type=str2bool, default=False)
    parser.add_argument("-id", "--run_id", type=str, required=True)
    parser.add_argument("-n", "--namespace", type=optional_str, default="swebench")
    parser.add_argument("--instance_image_tag", type=str, default="latest")
    parser.add_argument("--env_image_tag", type=str, default="latest")
    parser.add_argument("--rewrite_reports", type=str2bool, default=False)
    parser.add_argument("--report_dir", type=str, default=".")
    parser.add_argument("--modal", type=str2bool, default=False)
    args = parser.parse_args()

    patch_astropy_3x_specs()
    patch_swebench_image_listing()
    run_evaluation_main(**vars(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
