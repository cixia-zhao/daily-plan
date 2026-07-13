from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import hmac
import secrets
from dataclasses import dataclass


_PASSWORD_HASH_PREFIX = "scrypt"
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def hash_password(password: str) -> str:
    if len(password) < 16:
        raise ValueError("访问密码至少需要 16 个字符")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_SCRYPT_DKLEN
    )
    return "$".join(
        (_PASSWORD_HASH_PREFIX, str(_SCRYPT_N), str(_SCRYPT_R), str(_SCRYPT_P), _encode(salt), _encode(digest))
    )


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        prefix, n, r, p, encoded_salt, expected_digest = stored_hash.split("$", 5)
        if prefix != _PASSWORD_HASH_PREFIX:
            return False
        digest = hashlib.scrypt(
            password.encode("utf-8"),
            salt=_decode(encoded_salt),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(_decode(expected_digest)),
        )
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(_encode(digest), expected_digest)


def validate_password_hash(stored_hash: str) -> None:
    parts = stored_hash.split("$")
    if len(parts) != 6 or parts[0] != _PASSWORD_HASH_PREFIX:
        raise ValueError("APP_AUTH_PASSWORD_HASH 格式无效")
    try:
        n, r, p = (int(value) for value in parts[1:4])
        salt = _decode(parts[4])
        digest = _decode(parts[5])
    except (TypeError, ValueError) as error:
        raise ValueError("APP_AUTH_PASSWORD_HASH 格式无效") from error
    if n < _SCRYPT_N or r < _SCRYPT_R or p < _SCRYPT_P or len(salt) < 16 or len(digest) < 32:
        raise ValueError("APP_AUTH_PASSWORD_HASH 强度不足或格式无效")


@dataclass(frozen=True)
class AuthSettings:
    required: bool
    password_hash: str | None
    session_secret: str
    session_max_age: int = 30 * 24 * 60 * 60


def build_auth_settings(runtime_mode: str, password_hash: str | None, session_secret: str | None) -> AuthSettings:
    required = runtime_mode == "production"
    if not required:
        return AuthSettings(required=False, password_hash=None, session_secret=session_secret or "development-only-session-secret")
    if not password_hash or not session_secret:
        raise RuntimeError("生产环境必须设置 APP_AUTH_PASSWORD_HASH 和 APP_SESSION_SECRET")
    if len(session_secret) < 32:
        raise RuntimeError("APP_SESSION_SECRET 至少需要 32 个字符")
    try:
        validate_password_hash(password_hash)
    except ValueError as error:
        raise RuntimeError(str(error)) from error
    return AuthSettings(required=True, password_hash=password_hash, session_secret=session_secret)


def _main() -> None:
    parser = argparse.ArgumentParser(description="生成今日航线生产环境登录凭据")
    parser.parse_args()
    password = getpass.getpass("设置访问密码（至少 16 个字符）：")
    confirmation = getpass.getpass("再次输入访问密码：")
    if password != confirmation:
        raise SystemExit("两次输入的密码不一致")
    print(f"APP_AUTH_PASSWORD_HASH='{hash_password(password)}'")
    print(f"APP_SESSION_SECRET='{secrets.token_urlsafe(48)}'")


if __name__ == "__main__":
    _main()
