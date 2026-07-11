from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from typing import Mapping


BENCHMARK_MODEL_PROVIDER = "openrouter"
BENCHMARK_PROVIDER_KEY_ENV = "OPENROUTER_API_KEY"
BENCHMARK_MODEL_ENV = "OPENROUTER_MODEL"
BENCHMARK_INTERNAL_MODEL_PROVIDER_ENV = "KESTREL_BENCHMARK_MODEL_PROVIDER"
BENCHMARK_INTERNAL_MODEL_ENV = "KESTREL_BENCHMARK_MODEL"
DEFAULT_OPENROUTER_BENCHMARK_MODEL = "z-ai/glm-5.2"
BENCHMARK_INTERACTION_MODE = "build"
BENCHMARK_ACT_SUBMODE = "full_auto"

DEPRECATED_BENCHMARK_ENV: dict[str, str] = {
    "KESTREL_TBENCH_MODEL_PROVIDER": "OpenRouter is the only supported Kestrel benchmark provider; remove this variable.",
    "KCHAT_MODEL_PROVIDER": "OpenRouter is the only supported Kestrel benchmark provider; remove this variable.",
    "KESTREL_TBENCH_MODEL": "Use OPENROUTER_MODEL instead.",
    "KCHAT_MODEL": "Use OPENROUTER_MODEL instead.",
    "KESTREL_SWE_MODEL_NAME": "Use OPENROUTER_MODEL instead.",
}


@dataclass(frozen=True)
class BenchmarkProviderConfig:
    model_provider: str
    model: str
    credential_env: str
    credential_fingerprint: str | None


def benchmark_turn_mode() -> dict[str, str]:
    return {
        "interactionMode": BENCHMARK_INTERACTION_MODE,
        "actSubmode": BENCHMARK_ACT_SUBMODE,
    }


def benchmark_profile_mode() -> dict[str, str]:
    return {
        "defaultInteractionMode": BENCHMARK_INTERACTION_MODE,
        "defaultActSubmode": BENCHMARK_ACT_SUBMODE,
    }


def assert_benchmark_turn_mode(turn: Mapping[str, object], label: str = "benchmark job turn") -> None:
    if turn.get("interactionMode") != BENCHMARK_INTERACTION_MODE:
        raise AssertionError(f"{label} must use canonical build interactionMode.")
    if turn.get("actSubmode") != BENCHMARK_ACT_SUBMODE:
        raise AssertionError(f"{label} must use full_auto actSubmode.")


def assert_benchmark_profile_mode(profile: Mapping[str, object], label: str = "benchmark profile") -> None:
    if profile.get("defaultInteractionMode") != BENCHMARK_INTERACTION_MODE:
        raise AssertionError(f"{label} must use canonical build defaultInteractionMode.")
    if profile.get("defaultActSubmode") != BENCHMARK_ACT_SUBMODE:
        raise AssertionError(f"{label} must use full_auto defaultActSubmode.")


def resolve_benchmark_provider_config(env: Mapping[str, str] | None = None) -> BenchmarkProviderConfig:
    source = os.environ if env is None else env
    return BenchmarkProviderConfig(
        model_provider=read_env(source, BENCHMARK_INTERNAL_MODEL_PROVIDER_ENV) or BENCHMARK_MODEL_PROVIDER,
        model=read_env(source, BENCHMARK_INTERNAL_MODEL_ENV)
        or read_env(source, BENCHMARK_MODEL_ENV)
        or DEFAULT_OPENROUTER_BENCHMARK_MODEL,
        credential_env=BENCHMARK_PROVIDER_KEY_ENV,
        credential_fingerprint=credential_fingerprint(source),
    )


def assert_benchmark_provider_env(env: Mapping[str, str] | None = None) -> None:
    issues = benchmark_provider_issues(env)
    if issues:
        raise RuntimeError(" ".join(issues))


def benchmark_provider_issues(env: Mapping[str, str] | None = None) -> list[str]:
    source = os.environ if env is None else env
    issues: list[str] = []
    internal_provider = read_env(source, BENCHMARK_INTERNAL_MODEL_PROVIDER_ENV)
    if internal_provider is not None and internal_provider != BENCHMARK_MODEL_PROVIDER:
        issues.append(
            f"Benchmark model provider must be {BENCHMARK_MODEL_PROVIDER}; "
            f"{BENCHMARK_INTERNAL_MODEL_PROVIDER_ENV}={internal_provider} is not supported."
        )
    for name, replacement in DEPRECATED_BENCHMARK_ENV.items():
        if read_env(source, name) is not None:
            issues.append(f"Deprecated benchmark env {name} is not supported. {replacement}")
    if read_env(source, BENCHMARK_PROVIDER_KEY_ENV) is None:
        configured = [
            name
            for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY")
            if read_env(source, name) is not None
        ]
        if configured:
            issues.append(
                "Kestrel benchmarks require OPENROUTER_API_KEY; ignoring non-OpenRouter provider key(s): "
                + ", ".join(configured)
                + "."
            )
        else:
            issues.append("Kestrel benchmarks require OPENROUTER_API_KEY.")
    return issues


def benchmark_provider_artifact_payload(env: Mapping[str, str] | None = None) -> dict[str, str]:
    config = resolve_benchmark_provider_config(env)
    payload = {
        "model_provider": config.model_provider,
        "model": config.model,
        "credential_env": config.credential_env,
    }
    if config.credential_fingerprint is not None:
        payload["credential_fingerprint"] = config.credential_fingerprint
    return payload


def credential_fingerprint(env: Mapping[str, str]) -> str | None:
    key = read_env(env, BENCHMARK_PROVIDER_KEY_ENV)
    if key is None:
        return None
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def read_env(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None
