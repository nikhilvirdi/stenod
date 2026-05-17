"""
Resource Adapter Service (Layer 3 Component).
Adapts memory retrieval and storage operations dynamically based on active hardware and system states.
"""

from typing import Dict, Any, Optional
from app.services.context_monitor import ContextMonitor
from app.utils.logger import get_logger

log = get_logger(__name__)

class ResourceAdapter:
    """
    Manages resource-aware routing strategies based on system status.
    Modes of operation:
      - Normal: Fully searches episodic (vector) and semantic (relational) stores.
      - Low RAM: Skips expensive vector searches entirely; returns summarized Working Memory only.
      - Low Battery: Truncates ChromaDB top-k searches, skips post-call background semantic extractions.
      - Offline: Uses local SQLite operations only (Semantic / Pins / Tasks), avoiding external or vector actions.
    """
    _manual_mode: Optional[str] = None

    @classmethod
    def set_manual_mode(cls, mode: Optional[str]) -> None:
        """
        Manually overrides the resource adaptation mode.
        """
        if mode is None:
            cls._manual_mode = None
            log.info("ResourceAdapter: Cleared manual mode override. Reverting to automatic detection.")
            return

        mode_clean = mode.strip().upper()
        if mode_clean in ("NORMAL", "LOW RAM", "LOW_RAM", "LOWRAM"):
            cls._manual_mode = "Normal" if mode_clean == "NORMAL" else "Low RAM"
        elif mode_clean in ("LOW BATTERY", "LOW_BATTERY", "LOWBATTERY"):
            cls._manual_mode = "Low Battery"
        elif mode_clean == "OFFLINE":
            cls._manual_mode = "Offline"
        else:
            raise ValueError(
                f"Invalid mode: '{mode}'. Allowed modes: 'Normal', 'Low RAM', 'Low Battery', 'Offline'"
            )
        log.info(f"ResourceAdapter: Manually set mode override to '{cls._manual_mode}'")

    @classmethod
    def get_manual_mode(cls) -> Optional[str]:
        """
        Returns the active manual mode override, if any.
        """
        return cls._manual_mode

    @classmethod
    def get_current_mode(cls, context_monitor: ContextMonitor) -> str:
        """
        Determines the current resource mode based on system resources or manual override.
        """
        if cls._manual_mode is not None:
            return cls._manual_mode

        # Gather system resources from ContextMonitor
        try:
            resources = context_monitor.get_system_resources()
        except Exception as e:
            log.error(f"Failed to read system resources: {e}. Defaulting to 'Normal'.")
            return "Normal"

        # Check thresholds in order of priority:
        # 1. Offline Mode (strictly when network is down or not online)
        if not resources.get("is_online", True):
            return "Offline"

        # 2. Low RAM Mode (RAM usage > 80% or available RAM < 512MB)
        ram_percent = resources.get("ram_percent_used", 0.0)
        ram_available = resources.get("ram_available_mb", 1024.0)
        if ram_percent > 80.0 or ram_available < 512.0:
            return "Low RAM"

        # 3. Low Battery Mode (Battery < 20% and not plugged in/charging)
        battery_percent = resources.get("battery_percent", 100.0)
        is_charging = resources.get("is_charging", False)
        if battery_percent < 20.0 and not is_charging:
            return "Low Battery"

        return "Normal"
