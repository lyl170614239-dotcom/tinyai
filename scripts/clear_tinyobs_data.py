#!/usr/bin/env python3
"""Clear all TinyAI Observability database data for local retesting.

Default target:
  host: 127.0.0.1
  port: 13306
  db:   tinyobs
  user: root
  pass: tinyobs-root

The script first tries a direct PyMySQL connection. If PyMySQL is not installed,
it falls back to running mysql inside the local Docker container.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import subprocess
import sys
from dataclasses import dataclass


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
ENV_FILE = PROJECT_ROOT / ".env"

TABLES = [
    "pull_request_attributions",
    "ai_line_attributions",
    "ai_code_changes",
    "ai_spec_accesses",
    "ai_process_steps",
    "ai_request_usage",
    "ai_messages",
    "ai_turns",
    "ai_sessions",
    "normalized_ingest_events",
    "ingest_jobs",
    "raw_event_blobs",
    "raw_ingest_events",
    "plugin_heartbeats",
    "plugin_clients",
]


@dataclass(frozen=True)
class DbConfig:
    host: str
    port: int
    database: str
    user: str
    password: str
    docker_container: str


def load_dotenv(path: pathlib.Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def config_from_env() -> DbConfig:
    load_dotenv(ENV_FILE)
    return DbConfig(
        host=os.getenv("TINYOBS_DB_HOST", "127.0.0.1"),
        port=int(os.getenv("TINYOBS_DB_PORT", os.getenv("OBS_MYSQL_PORT", "13306"))),
        database=os.getenv("TINYOBS_DB_NAME", os.getenv("MYSQL_DATABASE", "tinyobs")),
        user=os.getenv("TINYOBS_DB_USER", "root"),
        password=os.getenv("TINYOBS_DB_PASSWORD", os.getenv("MYSQL_ROOT_PASSWORD", "tinyobs-root")),
        docker_container=os.getenv("TINYOBS_MYSQL_CONTAINER", "tinyai-observability-mysql"),
    )


def quoted_identifier(name: str) -> str:
    return f"`{name.replace('`', '``')}`"


def build_sql(dry_run: bool) -> str:
    count_selects = "\n".join(
        f"SELECT '{table}' AS table_name, COUNT(*) AS row_count FROM {quoted_identifier(table)};"
        for table in TABLES
    )
    if dry_run:
        return count_selects

    truncates = "\n".join(f"TRUNCATE TABLE {quoted_identifier(table)};" for table in TABLES)
    return f"""
SET FOREIGN_KEY_CHECKS = 0;
{count_selects}
{truncates}
SET FOREIGN_KEY_CHECKS = 1;
{count_selects}
""".strip()


def clear_with_pymysql(cfg: DbConfig, dry_run: bool) -> bool:
    try:
        import pymysql  # type: ignore
    except ModuleNotFoundError:
        return False

    connection = pymysql.connect(
        host=cfg.host,
        port=cfg.port,
        user=cfg.user,
        password=cfg.password,
        database=cfg.database,
        charset="utf8mb4",
        autocommit=False,
    )
    try:
        with connection.cursor() as cursor:
            print(f"Connected via PyMySQL: {cfg.user}@{cfg.host}:{cfg.port}/{cfg.database}")
            print("Before:")
            before = table_counts(cursor)
            print_counts(before)
            if not dry_run:
                cursor.execute("SET FOREIGN_KEY_CHECKS = 0")
                for table in TABLES:
                    cursor.execute(f"TRUNCATE TABLE {quoted_identifier(table)}")
                cursor.execute("SET FOREIGN_KEY_CHECKS = 1")
                connection.commit()
                print("After:")
                after = table_counts(cursor)
                print_counts(after)
            else:
                connection.rollback()
                print("Dry run only. No data was deleted.")
        return True
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def table_counts(cursor) -> list[tuple[str, int]]:
    rows: list[tuple[str, int]] = []
    for table in TABLES:
        cursor.execute(f"SELECT COUNT(*) FROM {quoted_identifier(table)}")
        count = cursor.fetchone()[0]
        rows.append((table, int(count)))
    return rows


def print_counts(rows: list[tuple[str, int]]) -> None:
    width = max(len(table) for table, _ in rows)
    for table, count in rows:
        print(f"  {table:<{width}}  {count}")


def clear_with_docker_mysql(cfg: DbConfig, dry_run: bool) -> None:
    print(f"PyMySQL not available; falling back to Docker mysql: {cfg.docker_container}")
    cmd = [
        "docker",
        "exec",
        "-i",
        "-e",
        f"MYSQL_PWD={cfg.password}",
        cfg.docker_container,
        "mysql",
        "--default-character-set=utf8mb4",
        "-u",
        cfg.user,
        cfg.database,
    ]
    result = subprocess.run(
        cmd,
        input=build_sql(dry_run),
        text=True,
        cwd=str(PROJECT_ROOT),
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    if dry_run:
        print("Dry run only. No data was deleted.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Clear all TinyAI Observability DB tables.")
    parser.add_argument("--dry-run", action="store_true", help="Only print row counts; do not delete data.")
    args = parser.parse_args()

    cfg = config_from_env()
    print("TinyAI DB clear target:")
    print(f"  database: {cfg.database}")
    print(f"  host:     {cfg.host}:{cfg.port}")
    print(f"  user:     {cfg.user}")
    print(f"  tables:   {len(TABLES)}")

    try:
        if not clear_with_pymysql(cfg, args.dry_run):
            clear_with_docker_mysql(cfg, args.dry_run)
    except Exception as exc:
        print(f"Failed to clear database: {exc}", file=sys.stderr)
        return 1

    if not args.dry_run:
        print("Done. All TinyAI Observability table data has been cleared.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
