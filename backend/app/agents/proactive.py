"""
Proactive Agent (Layer 3 Component).
Runs as a background service via APScheduler, periodically analyzing task lists,
semantic memory, and recent context logs to generate smart, contextual, proactive recommendations.
"""

import asyncio
from typing import Optional, Dict, Any, List
from sqlalchemy.orm import Session
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.db.database import SessionLocal
from app.db.models import ProactiveSuggestion, ContextLog
from app.services.ollama import OllamaService
from app.services.context_monitor import get_context_monitor
from app.memory.task import TaskManager
from app.memory.semantic import SemanticMemoryManager
from app.utils.logger import get_logger

log = get_logger(__name__)

class ProactiveAgent:
    """
    Proactive Agent runs continuously in the background. It analyzes all memory tiers,
    assesses current device resource context, and generates highly targeted suggestions or alerts.
    """
    def __init__(self, db_session_factory=SessionLocal):
        self.session_factory = db_session_factory
        self.llm = OllamaService()
        self.context_monitor = get_context_monitor()
        self.scheduler = AsyncIOScheduler()
        self._running = False

    async def analyze_and_suggest(self) -> Optional[ProactiveSuggestion]:
        """
        Main evaluation cycle. Queries memory tiers and device context,
        asks LLM for potential proactive ideas, and writes suggestions to the DB.
        """
        log.info("ProactiveAgent: Starting analysis cycle...")
        db: Session = self.session_factory()
        try:
            # 1. Gather context from memory tiers and system monitor
            task_mgr = TaskManager(db)
            semantic_mgr = SemanticMemoryManager(db)
            
            active_tasks = task_mgr.get_active_tasks()
            facts = semantic_mgr.get_all_facts()
            
            # Retrieve recent context logs
            recent_logs = db.query(ContextLog).order_by(ContextLog.timestamp.desc()).limit(5).all()
            
            # Gather current real/simulated system state
            system_state = self.context_monitor.capture_current_context()
            
            # Format collected data for analysis
            tasks_str = "\n".join([f"- [ID {t.id}, Priority {t.priority}] {t.title}: {t.description} ({t.status})" for t in active_tasks]) if active_tasks else "None"
            facts_str = "\n".join([f"- {f['key']}: {f['value']}" for f in facts]) if facts else "None"
            
            logs_str = ""
            if recent_logs:
                logs_str = "\n".join([
                    f"- {l.timestamp}: App={l.app}, Battery={l.battery}%, Charging={l.charging}, RAM={l.ram_percent}%, CPU={l.cpu_percent}%"
                    for l in recent_logs
                ])
            else:
                logs_str = "None"
                
            current_state_str = (
                f"Foreground App: {system_state.get('app')}\n"
                f"RAM Usage: {system_state.get('ram_percent_used')}%\n"
                f"CPU Usage: {system_state.get('cpu_percent')}%\n"
                f"Battery: {system_state.get('battery')}% (Charging: {system_state.get('charging')})\n"
                f"Network: {'Online' if system_state.get('is_online') else 'Offline'}"
            )
            
            # 2. Build analysis prompt
            analysis_prompt = (
                "You are the Proactive Agent of the Mnemosyne memory operating system.\n"
                "Your objective is to review the user's current situation and background state, "
                "and decide if there is any critical alert, productivity advice, scheduling recommendation, "
                "or helpful reminder that should be actively suggested to them.\n\n"
                "### User Profile & Preferences:\n"
                f"{facts_str}\n\n"
                "### Active Goals & Tasks:\n"
                f"{tasks_str}\n\n"
                "### Recent System Context Logs:\n"
                f"{logs_str}\n\n"
                "### Current Live Device Context:\n"
                f"{current_state_str}\n\n"
                "Instructions:\n"
                "1. Look for patterns or critical situations (e.g., high memory usage warning, task deadlines, time-of-day habits, battery warnings, or goal alignment).\n"
                "2. If you find a highly relevant suggestion, output ONLY the suggestion text (1-2 sentences). Do not include any introductory remarks like 'Here is a suggestion:' or markdown headers.\n"
                "3. If everything is normal and no actionable suggestion is needed, respond with exactly 'NONE'.\n"
                "4. Be concise, context-aware, and extremely useful."
            )
            
            log.debug("ProactiveAgent: Dispatching analysis to LLM...")
            raw_response = await self.llm.generate(prompt=analysis_prompt)
            suggestion_text = raw_response.strip()
            
            # Clean up the output in case the LLM returned markdown or wrapping
            if suggestion_text.startswith("```"):
                suggestion_text = suggestion_text.strip("`").strip()
            
            if not suggestion_text or suggestion_text.upper() == "NONE":
                log.info("ProactiveAgent: Analysis completed. No proactive suggestion triggered.")
                return None
                
            log.info(f"ProactiveAgent: Triggered suggestion: '{suggestion_text}'")
            
            # 3. Persist the proactive suggestion
            new_suggestion = ProactiveSuggestion(
                suggestion_text=suggestion_text,
                triggered_context=current_state_str
            )
            db.add(new_suggestion)
            db.commit()
            db.refresh(new_suggestion)
            
            return new_suggestion
            
        except Exception as e:
            log.error(f"ProactiveAgent: Error in suggestion analysis cycle: {e}")
            return None
        finally:
            db.close()

    def start(self, interval_seconds: int = 30):
        """
        Starts the background scheduling job.
        """
        if self._running:
            log.warning("ProactiveAgent: Already running.")
            return

        log.info(f"ProactiveAgent: Starting background job scheduler with interval={interval_seconds}s")
        self.scheduler.add_job(
            self.analyze_and_suggest,
            trigger="interval",
            seconds=interval_seconds,
            id="proactive_analysis_job",
            replace_existing=True
        )
        self.scheduler.start()
        self._running = True

    def stop(self):
        """
        Stops the background scheduling job.
        """
        if not self._running:
            log.warning("ProactiveAgent: Not running.")
            return

        log.info("ProactiveAgent: Stopping background job scheduler")
        self.scheduler.shutdown()
        self._running = False
