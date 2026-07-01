import inspect
import unittest

from app.api.health import health
from app.config import Settings
from app.database import database_engine_kwargs, mysql_connect_args


class RuntimeResilienceTests(unittest.TestCase):
    def test_health_endpoint_is_async_and_does_not_need_threadpool(self):
        self.assertTrue(inspect.iscoroutinefunction(health))

    def test_mysql_connect_args_include_socket_timeouts_for_mysql_urls(self):
        settings = Settings(
            database_url="mysql+pymysql://tinyobs:tinyobs@mysql:3306/tinyobs",
            mysql_connect_timeout_seconds=3,
            mysql_read_timeout_seconds=4,
            mysql_write_timeout_seconds=5,
        )

        self.assertEqual(
            mysql_connect_args(settings),
            {
                "connect_timeout": 3,
                "read_timeout": 4,
                "write_timeout": 5,
            },
        )

    def test_mysql_connect_args_are_empty_for_sqlite(self):
        settings = Settings(database_url="sqlite:///:memory:")

        self.assertEqual(mysql_connect_args(settings), {})

    def test_database_engine_kwargs_do_not_apply_queue_pool_options_to_sqlite(self):
        settings = Settings(database_url="sqlite:///:memory:")

        self.assertEqual(
            database_engine_kwargs(settings),
            {
                "pool_pre_ping": True,
                "connect_args": {},
            },
        )


if __name__ == "__main__":
    unittest.main()
