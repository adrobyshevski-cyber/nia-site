#!/usr/bin/env python3
"""Генератор пароля и хеша для /studio.

    python scripts/make-admin-password.py            # новый пароль + строка для секрета
    python scripts/make-admin-password.py --hash     # хеш для заданного пароля (stdin)

Хеш — sha256(salt ‖ пароль): на бесплатном плане Workers лимит 10 мс CPU,
а PBKDF2 со 100k+ итераций в него не укладывается. Защита держится на энтропии
случайного пароля, поэтому пароль генерируется, а не придумывается.
"""

import base64
import getpass
import hashlib
import secrets
import sys

ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # без I/l/1/0/o
GROUPS = 5
GROUP_LEN = 4


def make_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.sha256(salt + password.encode("utf-8")).digest()
    return f"sha256${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def make_password() -> str:
    return "-".join("".join(secrets.choice(ALPHABET) for _ in range(GROUP_LEN)) for _ in range(GROUPS))


def main() -> int:
    if "--hash" in sys.argv:
        password = sys.stdin.readline().rstrip("\n") if not sys.stdin.isatty() else getpass.getpass("Пароль: ")
        if not password:
            print("пустой пароль", file=sys.stderr)
            return 1
        print(make_hash(password))
        return 0

    password = make_password()
    print(f"Пароль (показан один раз):\n  {password}")
    print()
    print("Секрет для Worker'а:")
    print(f"  ADMIN_PASSWORD_HASH={make_hash(password)}")
    print()
    print("Дальше:")
    print("  npx wrangler secret put ADMIN_PASSWORD_HASH")
    print("  npx wrangler secret put SESSION_SECRET   # 32 случайных байта в base64")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
