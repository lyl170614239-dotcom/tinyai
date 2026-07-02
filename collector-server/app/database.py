from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings
from .identity import normalize_plugin_user_id


class Base(DeclarativeBase):
    pass


def mysql_connect_args(settings) -> dict[str, int]:
    if not settings.database_url.startswith("mysql"):
        return {}
    return {
        "connect_timeout": settings.mysql_connect_timeout_seconds,
        "read_timeout": settings.mysql_read_timeout_seconds,
        "write_timeout": settings.mysql_write_timeout_seconds,
    }


def database_engine_kwargs(settings) -> dict:
    kwargs = {
        "pool_pre_ping": True,
        "connect_args": mysql_connect_args(settings),
    }
    if settings.database_url.startswith("mysql"):
        kwargs.update(
            {
                "pool_size": settings.db_pool_size,
                "max_overflow": settings.db_max_overflow,
                "pool_timeout": settings.db_pool_timeout_seconds,
                "pool_recycle": settings.db_pool_recycle_seconds,
            }
        )
    return kwargs


settings = get_settings()
engine = create_engine(
    settings.database_url,
    **database_engine_kwargs(settings),
)


@event.listens_for(engine, "connect")
def _set_mysql_time_zone(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("SET time_zone = '+08:00'")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from .models import entities  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_identity_columns()
    _normalize_plugin_client_user_ids()
    _normalize_event_identity_columns()
    _deduplicate_plugin_clients()
    _ensure_product_table_storage()
    _ensure_turn_snapshot_storage()
    _ensure_line_attribution_storage()
    _ensure_multi_client_storage()
    _ensure_ingest_job_storage()
    _ensure_line_attribution_job_storage()
    _ensure_beijing_time_migration()


def _ensure_identity_columns() -> None:
    inspector = inspect(engine)
    session_columns = {
        "username": "VARCHAR(128) NULL",
        "user_id": "VARCHAR(128) NULL",
        "user_display_name": "VARCHAR(128) NULL",
        "team": "VARCHAR(128) NULL",
        "machine_id": "VARCHAR(128) NULL",
        "host_hash": "VARCHAR(128) NULL",
        "model": "VARCHAR(128) NULL",
    }
    table_columns = {
        table: {column["name"] for column in inspector.get_columns(table)}
        for table in ("plugin_clients", "ai_sessions")
        if inspector.has_table(table)
    }
    with engine.begin() as connection:
        for table, existing in table_columns.items():
            if "user_email" in existing:
                connection.execute(text(f"ALTER TABLE `{table}` DROP COLUMN `user_email`"))
                existing.remove("user_email")
            for name, ddl in session_columns.items():
                if name in existing:
                    continue
                connection.execute(text(f"ALTER TABLE `{table}` ADD COLUMN `{name}` {ddl}"))


def _normalize_plugin_client_user_ids() -> None:
    inspector = inspect(engine)
    if not inspector.has_table("plugin_clients"):
        return
    columns = {column["name"] for column in inspector.get_columns("plugin_clients")}
    if not {"user_id", "username", "user_display_name"}.issubset(columns):
        return
    with engine.begin() as connection:
        rows = connection.execute(
            text(
                """
                SELECT `client_id`, `username`, `user_id`, `user_display_name`
                FROM `plugin_clients`
                """
            )
        ).mappings().all()
        for row in rows:
            normalized = normalize_plugin_user_id(
                username=row.get("username"),
                user_id=row.get("user_id"),
                user_display_name=row.get("user_display_name"),
            )
            if normalized and normalized != row.get("user_id"):
                connection.execute(
                    text("UPDATE `plugin_clients` SET `user_id` = :user_id WHERE `client_id` = :client_id"),
                    {"user_id": normalized, "client_id": row["client_id"]},
                )


def _normalize_event_identity_columns() -> None:
    inspector = inspect(engine)
    targets = (
        ("raw_ingest_events", "event_id"),
        ("plugin_heartbeats", "event_id"),
        ("ai_sessions", "session_id"),
    )
    for table_name, pk_column in targets:
        if not inspector.has_table(table_name):
            continue
        columns = {column["name"] for column in inspector.get_columns(table_name)}
        required = {pk_column, "username", "user_id", "user_display_name"}
        if not required.issubset(columns):
            continue
        where = "`user_id` IS NULL OR `user_id` LIKE '%@%'"
        if engine.dialect.name in {"mysql", "mariadb"}:
            where = f"{where} OR `user_id` REGEXP '[^A-Za-z0-9._-]'"
        if "user_email" in columns:
            with engine.begin() as connection:
                connection.execute(text(f"ALTER TABLE `{table_name}` DROP COLUMN `user_email`"))
            columns.remove("user_email")
        with engine.begin() as connection:
            rows = connection.execute(
                text(
                    f"""
                    SELECT `{pk_column}` AS `pk`, `username`, `user_id`,
                           NULL AS `user_email`,
                           `user_display_name`
                    FROM `{table_name}`
                    WHERE {where}
                    """
                )
            ).mappings().all()
            for row in rows:
                normalized = normalize_plugin_user_id(
                    username=row.get("username"),
                    user_id=row.get("user_id"),
                    user_display_name=row.get("user_display_name"),
                )
                assignments = ["`user_id` = :user_id"]
                params = {"user_id": normalized, "pk": row["pk"]}
                connection.execute(
                    text(f"UPDATE `{table_name}` SET {', '.join(assignments)} WHERE `{pk_column}` = :pk"),
                    params,
                )


def _deduplicate_plugin_clients() -> None:
    inspector = inspect(engine)
    if not inspector.has_table("plugin_clients"):
        return
    columns = {column["name"] for column in inspector.get_columns("plugin_clients")}
    required = {"id", "tool", "plugin_name", "user_id", "machine_id", "host_hash", "client_id", "last_seen_at"}
    if not required.issubset(columns):
        return
    with engine.begin() as connection:
        rows = connection.execute(
            text(
                """
                SELECT `id`, `tool`, `plugin_name`, `user_id`, `machine_id`, `host_hash`, `client_id`, `last_seen_at`
                FROM `plugin_clients`
                WHERE `user_id` IS NOT NULL AND TRIM(`user_id`) != ''
                ORDER BY `last_seen_at` DESC, `id` DESC
                """
            )
        ).mappings().all()
        seen: set[tuple[str | None, str | None, str | None, str]] = set()
        duplicate_ids: list[int] = []
        for row in rows:
            device_key = row.get("machine_id") or row.get("host_hash") or row.get("client_id")
            key = (row.get("tool"), row.get("plugin_name"), row.get("user_id"), str(device_key))
            if key in seen:
                duplicate_ids.append(int(row["id"]))
                continue
            seen.add(key)
        if duplicate_ids:
            params = {f"id_{index}": value for index, value in enumerate(duplicate_ids)}
            placeholders = ", ".join(f":id_{index}" for index in range(len(duplicate_ids)))
            connection.execute(text(f"DELETE FROM `plugin_clients` WHERE `id` IN ({placeholders})"), params)


def _ensure_product_table_storage() -> None:
    inspector = inspect(engine)
    raw_json_tables = ("ai_sessions", "ai_turns", "ai_process_steps", "ai_code_changes", "ai_spec_accesses")
    with engine.begin() as connection:
        for table_name in raw_json_tables:
            if not inspector.has_table(table_name):
                continue
            columns = {column["name"] for column in inspector.get_columns(table_name)}
            if "raw_json" in columns:
                connection.execute(text(f"ALTER TABLE `{table_name}` DROP COLUMN `raw_json`"))

        if inspector.has_table("ai_spec_accesses"):
            columns = {column["name"] for column in inspector.get_columns("ai_spec_accesses")}
            spec_access_columns = {
                "access_type": "VARCHAR(16) NULL",
                "access_source": "VARCHAR(64) NULL",
                "matched_doc_count": "INT NOT NULL DEFAULT 0",
                "matched_docs": "JSON NULL",
            }
            for column_name, ddl in spec_access_columns.items():
                if column_name not in columns:
                    connection.execute(text(f"ALTER TABLE `ai_spec_accesses` ADD COLUMN `{column_name}` {ddl}"))

        if inspector.has_table("ai_messages"):
            columns = {column["name"]: column for column in inspector.get_columns("ai_messages")}
            message_source_columns = {
                "raw_event_id": "VARCHAR(64) NULL",
                "raw_path": "VARCHAR(512) NULL",
                "source_key": "VARCHAR(256) NULL",
                "content_storage": "VARCHAR(24) NOT NULL DEFAULT 'inline'",
                "blob_ref": "VARCHAR(512) NULL",
                "blob_encoding": "VARCHAR(64) NULL",
                "blob_original_bytes": "BIGINT NULL",
                "blob_compressed_bytes": "BIGINT NULL",
                "blob_sha256": "VARCHAR(128) NULL",
            }
            for column_name, ddl in message_source_columns.items():
                if column_name not in columns:
                    connection.execute(text(f"ALTER TABLE `ai_messages` ADD COLUMN `{column_name}` {ddl}"))
            content = columns.get("content")
            if content is not None and "LONGTEXT" not in str(content["type"]).upper():
                connection.execute(text("ALTER TABLE `ai_messages` MODIFY COLUMN `content` LONGTEXT NULL"))
            if "raw_json" in columns:
                connection.execute(
                    text(
                        """
                        UPDATE `ai_messages`
                        SET
                            `raw_event_id` = COALESCE(
                                `raw_event_id`,
                                NULLIF(JSON_UNQUOTE(JSON_EXTRACT(`raw_json`, '$.raw_event_id')), 'null')
                            ),
                            `raw_path` = COALESCE(
                                `raw_path`,
                                NULLIF(JSON_UNQUOTE(JSON_EXTRACT(`raw_json`, '$.raw_path')), 'null')
                            ),
                            `source_key` = COALESCE(
                                `source_key`,
                                NULLIF(JSON_UNQUOTE(JSON_EXTRACT(`raw_json`, '$.source_key')), 'null')
                            )
                        WHERE `raw_json` IS NOT NULL
                        """
                    )
                )
                connection.execute(text("ALTER TABLE `ai_messages` DROP COLUMN `raw_json`"))
            indexes = {index["name"] for index in inspector.get_indexes("ai_messages")}
            if "ix_ai_messages_raw_event" not in indexes:
                connection.execute(text("ALTER TABLE `ai_messages` ADD INDEX `ix_ai_messages_raw_event` (`raw_event_id`)"))
            if "ix_ai_messages_source_key" not in indexes:
                connection.execute(
                    text("ALTER TABLE `ai_messages` ADD INDEX `ix_ai_messages_source_key` (`session_id`, `source_key`)")
                )

        if inspector.has_table("ai_sessions"):
            indexes = {index["name"] for index in inspector.get_indexes("ai_sessions")}
            if "ix_ai_sessions_recent" not in indexes:
                connection.execute(
                    text(
                        "ALTER TABLE `ai_sessions` "
                        "ADD INDEX `ix_ai_sessions_recent` (`last_activity_at` DESC, `created_at` DESC)"
                    )
                )


def _ensure_turn_snapshot_storage() -> None:
    inspector = inspect(engine)
    with engine.begin() as connection:
        if inspector.has_table("ai_turns"):
            columns = {column["name"]: column for column in inspector.get_columns("ai_turns")}
            for column_name in ("request_id", "response_id"):
                if column_name not in columns:
                    connection.execute(text(f"ALTER TABLE `ai_turns` ADD COLUMN `{column_name}` VARCHAR(256) NULL"))
            indexes = {index["name"] for index in inspector.get_indexes("ai_turns")}
            unique_constraints = {constraint["name"] for constraint in inspector.get_unique_constraints("ai_turns")}
            if "uq_ai_turns_session_index" in indexes or "uq_ai_turns_session_index" in unique_constraints:
                connection.execute(text("ALTER TABLE `ai_turns` DROP INDEX `uq_ai_turns_session_index`"))
                indexes.discard("uq_ai_turns_session_index")
                unique_constraints.discard("uq_ai_turns_session_index")
            if "uq_ai_turns_session_request_response" not in indexes and "uq_ai_turns_session_request_response" not in unique_constraints:
                connection.execute(
                    text(
                        "ALTER TABLE `ai_turns` "
                        "ADD UNIQUE `uq_ai_turns_session_request_response` (`session_id`, `request_id`, `response_id`)"
                    )
                )
                indexes.add("uq_ai_turns_session_request_response")
            if "ix_ai_turns_session_index" not in indexes:
                connection.execute(text("ALTER TABLE `ai_turns` ADD INDEX `ix_ai_turns_session_index` (`session_id`, `turn_index`)"))
            if "ix_ai_turns_request" not in indexes:
                connection.execute(text("ALTER TABLE `ai_turns` ADD INDEX `ix_ai_turns_request` (`session_id`, `request_id`)"))

        if inspector.has_table("ai_process_steps"):
            columns = {column["name"]: column for column in inspector.get_columns("ai_process_steps")}
            step_columns = {
                "request_id": "VARCHAR(256) NULL",
                "response_id": "VARCHAR(256) NULL",
                "step_id": "VARCHAR(128) NULL",
                "tool_call_id": "VARCHAR(256) NULL",
                "actor_path": "VARCHAR(512) NULL",
                "actor_type": "VARCHAR(64) NULL",
                "parent_tool_call_id": "VARCHAR(256) NULL",
                "raw_event_id": "VARCHAR(64) NULL",
                "raw_path": "VARCHAR(512) NULL",
            }
            for column_name, ddl in step_columns.items():
                if column_name not in columns:
                    connection.execute(text(f"ALTER TABLE `ai_process_steps` ADD COLUMN `{column_name}` {ddl}"))
            content = columns.get("content")
            if content is not None and "LONGTEXT" not in str(content["type"]).upper():
                connection.execute(text("ALTER TABLE `ai_process_steps` MODIFY COLUMN `content` LONGTEXT NULL"))
            unique_constraints = {constraint["name"] for constraint in inspector.get_unique_constraints("ai_process_steps")}
            indexes = {index["name"] for index in inspector.get_indexes("ai_process_steps")}
            if "uq_ai_steps_session_index_type_hash" in unique_constraints or "uq_ai_steps_session_index_type_hash" in indexes:
                connection.execute(text("ALTER TABLE `ai_process_steps` DROP INDEX `uq_ai_steps_session_index_type_hash`"))
            unique_constraints = {constraint["name"] for constraint in inspect(engine).get_unique_constraints("ai_process_steps")}
            if "uq_ai_steps_session_request_step" not in unique_constraints:
                connection.execute(
                    text(
                        "ALTER TABLE `ai_process_steps` "
                        "ADD UNIQUE `uq_ai_steps_session_request_step` (`session_id`, `request_id`, `step_id`)"
                    )
                )
            indexes = {index["name"] for index in inspector.get_indexes("ai_process_steps")}
            if "ix_ai_steps_request" not in indexes:
                connection.execute(text("ALTER TABLE `ai_process_steps` ADD INDEX `ix_ai_steps_request` (`session_id`, `request_id`)"))

        if inspector.has_table("ai_code_changes"):
            columns = {column["name"]: column for column in inspector.get_columns("ai_code_changes")}
            change_columns = {
                "request_id": "VARCHAR(256) NULL",
                "response_id": "VARCHAR(256) NULL",
                "snapshot_kind": "VARCHAR(64) NULL",
                "diff_hash": "VARCHAR(128) NULL",
                "is_effective": "TINYINT(1) NOT NULL DEFAULT 1",
                "superseded_by_event_id": "VARCHAR(64) NULL",
            }
            for column_name, ddl in change_columns.items():
                if column_name not in columns:
                    connection.execute(text(f"ALTER TABLE `ai_code_changes` ADD COLUMN `{column_name}` {ddl}"))
            indexes = {index["name"] for index in inspector.get_indexes("ai_code_changes")}
            if "ix_ai_code_changes_request" not in indexes:
                connection.execute(text("ALTER TABLE `ai_code_changes` ADD INDEX `ix_ai_code_changes_request` (`session_id`, `request_id`)"))
            if "ix_ai_code_changes_effective" not in indexes:
                connection.execute(text("ALTER TABLE `ai_code_changes` ADD INDEX `ix_ai_code_changes_effective` (`session_id`, `is_effective`)"))
            if "ix_ai_code_changes_effective_time" not in indexes:
                connection.execute(
                    text("ALTER TABLE `ai_code_changes` ADD INDEX `ix_ai_code_changes_effective_time` (`is_effective`, `occurred_at`, `id`)")
                )
            if "ix_ai_code_changes_type_effective_time" not in indexes:
                connection.execute(
                    text(
                        "ALTER TABLE `ai_code_changes` "
                        "ADD INDEX `ix_ai_code_changes_type_effective_time` (`change_type`, `is_effective`, `occurred_at`, `id`)"
                    )
                )


def _ensure_line_attribution_storage() -> None:
    inspector = inspect(engine)
    if not inspector.has_table("ai_line_attributions"):
        return
    with engine.begin() as connection:
        columns = {column["name"] for column in inspector.get_columns("ai_line_attributions")}
        required_columns = {
            "workspace_path_hash": "VARCHAR(128) NOT NULL DEFAULT ''",
            "client_id": "VARCHAR(128) NOT NULL DEFAULT ''",
            "username": "VARCHAR(128) NOT NULL DEFAULT ''",
            "user_id": "VARCHAR(128) NOT NULL DEFAULT ''",
            "machine_id": "VARCHAR(128) NOT NULL DEFAULT ''",
            "host_hash": "VARCHAR(128) NOT NULL DEFAULT ''",
            "session_id": "VARCHAR(128) NULL",
            "request_id": "VARCHAR(256) NULL",
            "response_id": "VARCHAR(256) NULL",
            "file_path": "VARCHAR(1024) NOT NULL",
            "line_no": "INT NOT NULL",
            "text_hash": "VARCHAR(128) NOT NULL",
            "text_preview": "TEXT NULL",
            "origin_author": "VARCHAR(32) NOT NULL DEFAULT 'unknown'",
            "last_editor": "VARCHAR(32) NOT NULL DEFAULT 'unknown'",
            "classification": "VARCHAR(64) NOT NULL DEFAULT 'unknown'",
            "origin_event_id": "VARCHAR(64) NULL",
            "last_event_id": "VARCHAR(64) NULL",
            "source_snapshot_kind": "VARCHAR(64) NULL",
            "occurred_at": "DATETIME NOT NULL",
            "created_at": "DATETIME NULL DEFAULT NOW()",
            "updated_at": "DATETIME NULL DEFAULT NOW()",
        }
        for column_name, ddl in required_columns.items():
            if column_name not in columns:
                connection.execute(text(f"ALTER TABLE `ai_line_attributions` ADD COLUMN `{column_name}` {ddl}"))
        indexes = {index["name"] for index in inspector.get_indexes("ai_line_attributions")}
        required_indexes = {
            "ix_ai_line_attr_scope_file_line": "(`workspace_path_hash`, `machine_id`, `user_id`, `file_path`(191), `line_no`)",
            "ix_ai_line_attr_scope_file_hash": "(`workspace_path_hash`, `machine_id`, `user_id`, `file_path`(191), `text_hash`)",
            "ix_ai_line_attr_event": "(`last_event_id`)",
            "ix_ai_line_attr_classification": "(`classification`)",
        }
        for index_name, columns_sql in required_indexes.items():
            if index_name not in indexes:
                connection.execute(text(f"ALTER TABLE `ai_line_attributions` ADD INDEX `{index_name}` {columns_sql}"))


def _ensure_line_attribution_job_storage() -> None:
    inspector = inspect(engine)
    if not inspector.has_table("line_attribution_jobs"):
        return
    with engine.begin() as connection:
        columns = {column["name"] for column in inspector.get_columns("line_attribution_jobs")}
        required_columns = {
            "code_change_id": "INT NOT NULL",
            "event_id": "VARCHAR(64) NULL",
            "session_id": "VARCHAR(128) NOT NULL",
            "task_id": "VARCHAR(64) NULL",
            "snapshot_kind": "VARCHAR(64) NULL",
            "file_path": "VARCHAR(1024) NULL",
            "status": "VARCHAR(24) NOT NULL DEFAULT 'pending'",
            "attempts": "INT NOT NULL DEFAULT 0",
            "max_attempts": "INT NOT NULL DEFAULT 5",
            "locked_at": "DATETIME NULL",
            "locked_by": "VARCHAR(128) NULL",
            "next_run_at": "DATETIME NULL DEFAULT NOW()",
            "last_error": "TEXT NULL",
            "created_at": "DATETIME NULL DEFAULT NOW()",
            "updated_at": "DATETIME NULL DEFAULT NOW()",
        }
        for column_name, ddl in required_columns.items():
            if column_name not in columns:
                connection.execute(text(f"ALTER TABLE `line_attribution_jobs` ADD COLUMN `{column_name}` {ddl}"))
        indexes = {index["name"] for index in inspector.get_indexes("line_attribution_jobs")}
        required_indexes = {
            "ix_line_attr_jobs_status_next": "(`status`, `next_run_at`)",
            "ix_line_attr_jobs_session": "(`session_id`)",
            "ix_line_attr_jobs_event": "(`event_id`)",
        }
        for index_name, columns_sql in required_indexes.items():
            if index_name not in indexes:
                connection.execute(text(f"ALTER TABLE `line_attribution_jobs` ADD INDEX `{index_name}` {columns_sql}"))


def _ensure_multi_client_storage() -> None:
    inspector = inspect(engine)
    identity_columns = {
        "username": "VARCHAR(128) NULL",
        "user_id": "VARCHAR(128) NULL",
        "user_display_name": "VARCHAR(128) NULL",
        "team": "VARCHAR(128) NULL",
        "machine_id": "VARCHAR(128) NULL",
        "host_hash": "VARCHAR(128) NULL",
    }
    with engine.begin() as connection:
        if inspector.has_table("raw_ingest_events"):
            columns = {column["name"] for column in inspector.get_columns("raw_ingest_events")}
            if "user_email" in columns:
                connection.execute(text("ALTER TABLE `raw_ingest_events` DROP COLUMN `user_email`"))
                columns.remove("user_email")
            for column_name, ddl in identity_columns.items():
                if column_name not in columns:
                    connection.execute(text(f"ALTER TABLE `raw_ingest_events` ADD COLUMN `{column_name}` {ddl}"))
            indexes = {index["name"] for index in inspector.get_indexes("raw_ingest_events")}
            raw_indexes = {
                "ix_raw_ingest_created_at": "(`created_at`)",
                "ix_raw_ingest_created_event": "(`created_at`, `event_id`)",
                "ix_raw_ingest_client_time": "(`client_id`, `occurred_at`)",
                "ix_raw_ingest_user_time": "(`user_id`, `occurred_at`)",
                "ix_raw_ingest_team_time": "(`team`, `occurred_at`)",
                "ix_raw_ingest_machine_time": "(`machine_id`, `occurred_at`)",
                "ix_raw_ingest_plugin_version_time": "(`plugin_name`, `plugin_version`, `occurred_at`)",
            }
            for index_name, columns_sql in raw_indexes.items():
                if index_name not in indexes:
                    connection.execute(text(f"ALTER TABLE `raw_ingest_events` ADD INDEX `{index_name}` {columns_sql}"))

        if inspector.has_table("ai_sessions"):
            columns = {column["name"] for column in inspector.get_columns("ai_sessions")}
            session_columns = {
                "client_id": "VARCHAR(128) NULL",
                "plugin_name": "VARCHAR(128) NULL",
                "plugin_version": "VARCHAR(64) NULL",
            }
            for column_name, ddl in session_columns.items():
                if column_name not in columns:
                    connection.execute(text(f"ALTER TABLE `ai_sessions` ADD COLUMN `{column_name}` {ddl}"))
            indexes = {index["name"] for index in inspector.get_indexes("ai_sessions")}
            session_indexes = {
                "ix_ai_sessions_user_activity": "(`user_id`, `last_activity_at`)",
                "ix_ai_sessions_team_activity": "(`team`, `last_activity_at`)",
                "ix_ai_sessions_machine_activity": "(`machine_id`, `last_activity_at`)",
                "ix_ai_sessions_client_activity": "(`client_id`, `last_activity_at`)",
                "ix_ai_sessions_tool_activity": "(`tool`, `last_activity_at`)",
            }
            for index_name, columns_sql in session_indexes.items():
                if index_name not in indexes:
                    connection.execute(text(f"ALTER TABLE `ai_sessions` ADD INDEX `{index_name}` {columns_sql}"))

        if inspector.has_table("ai_messages"):
            indexes = {index["name"] for index in inspector.get_indexes("ai_messages")}
            if "uq_ai_messages_session_source_key" not in indexes:
                connection.execute(
                    text("ALTER TABLE `ai_messages` ADD UNIQUE `uq_ai_messages_session_source_key` (`session_id`, `source_key`)")
                )

        if inspector.has_table("plugin_heartbeats"):
            columns = {column["name"] for column in inspector.get_columns("plugin_heartbeats")}
            if "user_email" in columns:
                connection.execute(text("ALTER TABLE `plugin_heartbeats` DROP COLUMN `user_email`"))
            indexes = {index["name"] for index in inspector.get_indexes("plugin_heartbeats")}
            heartbeat_indexes = {
                "ix_plugin_heartbeats_recent": "(`occurred_at`)",
                "ix_plugin_heartbeats_user_time": "(`user_id`, `occurred_at`)",
                "ix_plugin_heartbeats_team_time": "(`team`, `occurred_at`)",
            }
            for index_name, columns_sql in heartbeat_indexes.items():
                if index_name not in indexes:
                    connection.execute(text(f"ALTER TABLE `plugin_heartbeats` ADD INDEX `{index_name}` {columns_sql}"))

        if inspector.has_table("plugin_clients"):
            indexes = {index["name"] for index in inspector.get_indexes("plugin_clients")}
            plugin_indexes = {
                "ix_plugin_clients_last_seen": "(`last_seen_at`)",
                "ix_plugin_clients_identity_host": "(`tool`, `plugin_name`, `user_id`, `host_hash`)",
                "ix_plugin_clients_identity_machine": "(`tool`, `plugin_name`, `user_id`, `machine_id`)",
            }
            for index_name, columns_sql in plugin_indexes.items():
                if index_name not in indexes:
                    connection.execute(text(f"ALTER TABLE `plugin_clients` ADD INDEX `{index_name}` {columns_sql}"))


def _ensure_ingest_job_storage() -> None:
    inspector = inspect(engine)
    if not inspector.has_table("ingest_jobs"):
        return
    columns = {column["name"] for column in inspector.get_columns("ingest_jobs")}
    required_columns = {
        "raw_event_id": "VARCHAR(64) NOT NULL",
        "event_type": "VARCHAR(64) NOT NULL",
        "status": "VARCHAR(24) NOT NULL DEFAULT 'pending'",
        "attempts": "INT NOT NULL DEFAULT 0",
        "max_attempts": "INT NOT NULL DEFAULT 5",
        "next_run_at": "DATETIME NULL",
        "locked_at": "DATETIME NULL",
        "locked_by": "VARCHAR(128) NULL",
        "last_error": "TEXT NULL",
        "created_at": "DATETIME NULL DEFAULT NOW()",
        "updated_at": "DATETIME NULL DEFAULT NOW()",
    }
    with engine.begin() as connection:
        for column_name, ddl in required_columns.items():
            if column_name not in columns:
                connection.execute(text(f"ALTER TABLE `ingest_jobs` ADD COLUMN `{column_name}` {ddl}"))
        if "next_run_at" in columns:
            connection.execute(text("UPDATE `ingest_jobs` SET `next_run_at` = COALESCE(`next_run_at`, NOW())"))
        indexes = {index["name"] for index in inspector.get_indexes("ingest_jobs")}
        job_indexes = {
            "ix_ingest_jobs_status_next_run": "(`status`, `next_run_at`)",
            "ix_ingest_jobs_raw_event": "(`raw_event_id`)",
            "ix_ingest_jobs_locked": "(`status`, `locked_at`)",
        }
        for index_name, columns_sql in job_indexes.items():
            if index_name not in indexes:
                connection.execute(text(f"ALTER TABLE `ingest_jobs` ADD INDEX `{index_name}` {columns_sql}"))


def _ensure_beijing_time_migration() -> None:
    migration_name = "20260623_store_datetimes_as_beijing_local"
    datetime_columns = {
        "plugin_clients": ("last_seen_at", "created_at"),
        "plugin_heartbeats": ("occurred_at", "created_at"),
        "raw_ingest_events": ("occurred_at", "created_at"),
        "raw_event_blobs": ("created_at",),
        "ingest_jobs": ("next_run_at", "locked_at", "created_at", "updated_at"),
        "normalized_ingest_events": ("created_at",),
        "ai_sessions": ("started_at", "last_activity_at", "created_at", "updated_at"),
        "ai_turns": ("created_at", "completed_at"),
        "ai_messages": ("occurred_at", "created_at"),
        "ai_request_usage": ("occurred_at", "created_at", "updated_at"),
        "ai_process_steps": ("occurred_at", "created_at"),
        "ai_code_changes": ("occurred_at", "created_at"),
        "ai_line_attributions": ("occurred_at", "created_at", "updated_at"),
        "ai_spec_accesses": ("occurred_at", "created_at"),
        "pull_request_attributions": ("occurred_at", "created_at"),
    }
    inspector = inspect(engine)
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    name VARCHAR(128) PRIMARY KEY,
                    applied_at DATETIME NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        already_applied = connection.execute(
            text("SELECT 1 FROM schema_migrations WHERE name = :name"),
            {"name": migration_name},
        ).scalar()
        if already_applied:
            return

        for table_name, columns in datetime_columns.items():
            if not inspector.has_table(table_name):
                continue
            existing_columns = {column["name"] for column in inspector.get_columns(table_name)}
            update_columns = [column for column in columns if column in existing_columns]
            if not update_columns:
                continue
            assignments = ", ".join(f"`{column}` = DATE_ADD(`{column}`, INTERVAL 8 HOUR)" for column in update_columns)
            connection.execute(text(f"UPDATE `{table_name}` SET {assignments}"))

        connection.execute(
            text("INSERT INTO schema_migrations (name) VALUES (:name)"),
            {"name": migration_name},
        )
