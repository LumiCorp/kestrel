from __future__ import annotations

from typing import Any


ASTROPY_3X_INSTALL = "python -m pip install -e .[test] --verbose --no-build-isolation && python -m pip install 'pytest<7'"
ASTROPY_3X_BUILD_REQUIRES = "python -m pip install 'cython==0.29.36' 'jinja2==3.1.6'"
ASTROPY_3X_TEST_CMD = "pytest -rA"


def patch_astropy_3x_specs() -> None:
    """Keep old Astropy specs compatible with current build and pytest tooling."""
    from swebench.harness import constants as harness_constants
    from swebench.harness.constants.python import SPECS_ASTROPY

    for version in ("3.0", "3.1", "3.2"):
        spec = SPECS_ASTROPY.get(version)
        if spec is None:
            continue
        pre_install = list(spec.get("pre_install", []))
        if ASTROPY_3X_BUILD_REQUIRES not in pre_install:
            pre_install.append(ASTROPY_3X_BUILD_REQUIRES)
        spec["pre_install"] = pre_install
        spec["install"] = ASTROPY_3X_INSTALL
        spec["test_cmd"] = ASTROPY_3X_TEST_CMD

    # The aggregate map keeps the same dict today, but assign explicitly so this
    # wrapper remains correct if SWE-bench changes how constants are assembled.
    harness_constants.MAP_REPO_VERSION_TO_SPECS["astropy/astropy"] = SPECS_ASTROPY


def list_image_tags_without_per_image_inspect(client: Any) -> set[str]:
    tags: set[str] = set()
    for image in client.api.images(all=True):
        for tag in image.get("RepoTags") or []:
            if tag != "<none>:<none>":
                tags.add(tag)
    return tags


def patch_swebench_image_listing() -> None:
    from swebench.harness import docker_utils
    from swebench.harness import prepare_images
    from swebench.harness import run_evaluation

    docker_utils.list_images = list_image_tags_without_per_image_inspect
    prepare_images.list_images = list_image_tags_without_per_image_inspect
    run_evaluation.list_images = list_image_tags_without_per_image_inspect
