"""
Claude Mission Control Plugin System — Drop-in extensibility.

Developers can extend Mission Control by:
1. Dropping Python files into `plugins/` directory
2. Each plugin registers lifecycle hooks
3. Plugins are auto-loaded at startup

Plugin structure:
    plugins/
      my_plugin.py          # Single-file plugin
      my_complex_plugin/    # Package plugin
        __init__.py
        ...

Each plugin must define a `register(registry)` function:

    def register(registry):
        @registry.hook("post_complete")
        async def after_complete(mission: dict, report: dict):
            await send_slack_message(f"Mission {mission['title']} done!")

        @registry.hook("on_unblocked")
        async def on_ready(mission: dict):
            # React to a mission becoming ready (deps satisfied)
            pass
"""

import importlib
import importlib.util
import logging
import os
import sys
from pathlib import Path
from typing import Callable

log = logging.getLogger("mission_control.plugins")


class PluginRegistry:
    """Registry that plugins use to register hooks and extensions."""

    def __init__(self):
        self._hooks: dict[str, list[Callable]] = {
            "post_complete": [],
            "post_fail": [],
            "pre_plan": [],
            "post_plan": [],
            "on_unblocked": [],
        }
        self._loaded_plugins: list[str] = []

    def hook(self, event: str):
        """Decorator to register a lifecycle hook.

        Events:
            post_complete — After a mission completes. Receives (mission, report).
            post_fail     — After a mission fails. Receives (mission, session).
            pre_plan      — Before AI planner runs. Receives (prompt). Return modified prompt.
            post_plan     — After planner creates project. Receives (project, missions).
            on_unblocked  — When a mission's dependencies are satisfied and it becomes ready. Receives (mission).

        Usage:
            @registry.hook("post_complete")
            async def notify_slack(mission: dict, report: dict):
                await send_slack_message(f"Mission {mission['title']} done!")
        """
        def decorator(func: Callable):
            if event not in self._hooks:
                self._hooks[event] = []
            self._hooks[event].append(func)
            log.info(f"Plugin hook registered: {event} -> {func.__name__}")
            return func
        return decorator

    @property
    def loaded_plugins(self) -> list[str]:
        return self._loaded_plugins


# Global registry
registry = PluginRegistry()


def _plugins_dir() -> Path:
    """Resolve plugins directory — next to backend/ or via env var."""
    custom = os.environ.get("MISSION_CONTROL_PLUGINS_DIR")
    if custom:
        return Path(custom)
    project_root = Path(__file__).parent.parent
    return project_root / "plugins"


def load_plugins():
    """Discover and load all plugins from the plugins/ directory."""
    plugins_path = _plugins_dir()

    if not plugins_path.exists():
        log.info(f"No plugins directory at {plugins_path}, skipping")
        return

    # Add to sys.path so plugins can import each other
    plugins_str = str(plugins_path)
    if plugins_str not in sys.path:
        sys.path.insert(0, plugins_str)

    loaded = 0
    for entry in sorted(plugins_path.iterdir()):
        name = None
        try:
            if entry.is_file() and entry.suffix == ".py" and not entry.name.startswith("_"):
                name = entry.stem
                spec = importlib.util.spec_from_file_location(f"mc_plugin_{name}", entry)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)

                if hasattr(mod, "register"):
                    mod.register(registry)
                    registry._loaded_plugins.append(name)
                    loaded += 1
                    log.info(f"Plugin loaded: {name}")
                else:
                    log.warning(f"Plugin {name} has no register() function, skipping")

            elif entry.is_dir() and (entry / "__init__.py").exists():
                name = entry.name
                spec = importlib.util.spec_from_file_location(
                    f"mc_plugin_{name}",
                    entry / "__init__.py",
                    submodule_search_locations=[str(entry)],
                )
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)

                if hasattr(mod, "register"):
                    mod.register(registry)
                    registry._loaded_plugins.append(name)
                    loaded += 1
                    log.info(f"Plugin loaded: {name} (package)")
                else:
                    log.warning(f"Plugin {name} has no register() function, skipping")

        except Exception:
            log.exception(f"Failed to load plugin: {name or entry}")

    log.info(f"Loaded {loaded} plugin(s)")


