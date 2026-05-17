"""
Context Monitor Service.
Polls system resource states using psutil and incorporates an ADB stub for simulating 
foreground applications based on Android environments or dataset logs.
"""

import psutil
import datetime
from typing import Dict, Any, List
from app.config import get_settings
from app.utils.logger import get_logger

log = get_logger(__name__)

class ContextMonitor:
    """
    Monitors system resource usage and manages simulated ADB active tasks.
    Maintains a rolling context history buffer to feed Layer 2's prediction engine.
    """
    def __init__(self, history_limit: int = 10):
        self.settings = get_settings()
        self.history_limit = history_limit
        self.history: List[Dict[str, Any]] = []
        
        # ADB Stub state for simulation (represents foreground app lifecycle)
        self._simulated_foreground_app = "home_screen"
        self._simulated_charging = False
        self._simulated_battery_level = 100.0

    def set_simulated_state(self, app_name: str, charging: bool = False, battery_level: float = 100.0):
        """
        Allows test cases or benchmarks to inject a simulated environment state.
        Particularly useful for ADB stub emulation of Melbourne datasets.
        """
        self._simulated_foreground_app = app_name
        self._simulated_charging = charging
        self._simulated_battery_level = battery_level
        log.debug(f"ADB Stub updated: App={app_name}, Battery={battery_level}%, Charging={charging}")

    def get_system_resources(self) -> Dict[str, Any]:
        """
        Collects real-time OS metrics using psutil.
        """
        # Memory
        mem = psutil.virtual_memory()
        ram_percent_used = mem.percent
        ram_available_mb = mem.available / (1024 * 1024)

        # CPU
        cpu_percent = psutil.cpu_percent(interval=None)

        # Network Status
        net_info = psutil.net_if_addrs()
        is_online = len(net_info) > 0 # Simple check for active network interfaces

        # Battery (Fallback to simulation if desktop has no battery)
        psutil_battery = psutil.sensors_battery()
        if psutil_battery is not None:
            battery_percent = psutil_battery.percent
            is_charging = psutil_battery.power_plugged
        else:
            # Fallback to ADB stub
            battery_percent = self._simulated_battery_level
            is_charging = self._simulated_charging

        return {
            "ram_percent_used": ram_percent_used,
            "ram_available_mb": ram_available_mb,
            "cpu_percent": cpu_percent,
            "is_online": is_online,
            "battery_percent": battery_percent,
            "is_charging": is_charging
        }

    def capture_current_context(self) -> Dict[str, Any]:
        """
        Gathers both real OS metrics and foreground applications (real or simulated).
        Constructs a context frame compatible with the LSTM prediction engine.
        """
        now = datetime.datetime.now()
        resources = self.get_system_resources()

        # Context frame required by Layer 2 and Layer 1
        context_frame = {
            "timestamp": now.isoformat(),
            "app": self._simulated_foreground_app,
            "hour": now.hour,
            "day": now.weekday(),
            "battery": resources["battery_percent"],
            "charging": resources["is_charging"],
            "ram_percent_used": resources["ram_percent_used"],
            "cpu_percent": resources["cpu_percent"],
            "is_online": resources["is_online"]
        }

        # Append to rolling history
        self.history.append(context_frame)
        if len(self.history) > self.history_limit:
            self.history.pop(0)

        log.debug(f"Captured context: App={self._simulated_foreground_app}, RAM={resources['ram_percent_used']}%")
        return context_frame

    def get_recent_history(self, count: int = 5) -> List[Dict[str, Any]]:
        """
        Returns the last `count` context frames for LSTM input.
        """
        return self.history[-count:]

# Global shared instance of ContextMonitor
_global_context_monitor = None

def get_context_monitor() -> ContextMonitor:
    """
    Returns a shared, global singleton instance of ContextMonitor.
    """
    global _global_context_monitor
    if _global_context_monitor is None:
        _global_context_monitor = ContextMonitor()
    return _global_context_monitor
