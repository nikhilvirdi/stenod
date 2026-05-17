"""
Memory Router (Layer 3 Component).
The Central Nervous System that coordinates Working, Episodic, Semantic, Task, and Instruction Pin memories.
Handles automated context offloading, semantic extraction, and context injection without breaking module isolation.
"""

from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session
from app.memory.working import WorkingMemory
from app.memory.episodic import EpisodicMemory
from app.memory.semantic import SemanticMemoryManager
from app.memory.task import TaskManager
from app.memory.pins import InstructionPinManager
from app.services.context_monitor import get_context_monitor
from app.services.resource_adapter import ResourceAdapter
from app.utils.logger import get_logger

log = get_logger(__name__)

class MemoryRouter:
    """
    Orchestrates data flow between all memory modules.
    Ensures context is preserved (via Episodic offloading), extracted (via Semantic processing),
    and injected seamlessly without breaking individual module boundaries.
    """
    def __init__(self, db_session: Session, session_id: Optional[str] = None, max_working_tokens: int = 4096):
        self.context_monitor = get_context_monitor()
        self.working = WorkingMemory(session_id=session_id, max_tokens=max_working_tokens)
        self.episodic = EpisodicMemory()
        self.semantic = SemanticMemoryManager(db_session)
        self.task = TaskManager(db_session)
        self.pins = InstructionPinManager(db_session)
        self.session_id = self.working.session_id

    async def route_input(self, role: str, content: str) -> None:
        """
        Receives an interaction (user or assistant) and routes it to appropriate memory layers,
        adapting the behavior dynamically based on the active resource mode.
        """
        # Determine current resource mode
        mode = ResourceAdapter.get_current_mode(self.context_monitor)
        log.info(f"MemoryRouter [{self.session_id}]: Routing input under mode '{mode}'")

        # 1. Add to Working Memory
        evicted_summary = await self.working.add_message(role, content)
        
        # 2. Automated Episodic offload (skip in Offline mode as it is a vector action)
        if evicted_summary:
            if mode == "Offline":
                log.info(f"MemoryRouter [{self.session_id}]: Skipping episodic offload (Offline mode).")
            else:
                log.info(f"MemoryRouter [{self.session_id}]: Offloading evicted context to EpisodicMemory.")
                await self.episodic.store_episode(
                    text=evicted_summary,
                    metadata={
                        "session_id": self.session_id, 
                        "source": "working_memory_eviction"
                    }
                )
            
        # 3. Semantic Extraction for user messages (skip in Low Battery mode)
        if role.lower() == "user":
            if mode == "Low Battery":
                log.info(f"MemoryRouter [{self.session_id}]: Skipping semantic fact extraction (Low Battery mode).")
            else:
                log.debug(f"MemoryRouter [{self.session_id}]: Extracting semantic facts from user input.")
                await self.semantic.extract_and_store(content)

    async def get_augmented_context(self, query: str = "") -> List[Dict[str, str]]:
        """
        Compiles a comprehensive context window by injecting relevant data from all layers,
        dynamically optimized based on the current resource mode.
        """
        # Determine current resource mode
        mode = ResourceAdapter.get_current_mode(self.context_monitor)
        log.info(f"MemoryRouter [{self.session_id}]: Compiling augmented context under mode '{mode}'")

        # 1. Low RAM Mode optimization (skip vector/SQLite stores, return summarized working memory only)
        if mode == "Low RAM":
            log.info(f"MemoryRouter [{self.session_id}]: Returning summarized Working Memory only.")
            return await self.working.get_summarized_context()

        # 2. Compile Instruction Pins (local SQLite, skipped in Low RAM only)
        pins_str = self.pins.compile_instruction_block()

        # 3. Gather Semantic Facts (local SQLite, skipped in Low RAM only)
        semantic_facts = self.semantic.get_all_facts()
        facts_str = ""
        if semantic_facts:
            facts_str = "\n".join([f"- {f['key']}: {f['value']}" for f in semantic_facts])
        
        # 4. Gather Relevant Episodes (vector store, skipped in Low RAM and Offline)
        episodes_str = ""
        if query and mode != "Offline":
            # Under Low Battery mode, truncate top-k retrieval to 1 result instead of 3
            limit = 1 if mode == "Low Battery" else 3
            log.debug(f"MemoryRouter [{self.session_id}]: Querying episodic vector database with limit={limit}")
            episodes = await self.episodic.search_episodes(query, limit=limit)
            if episodes:
                episodes_str = "\n".join([f"- {e['document']}" for e in episodes])
            
        # 5. Gather Active Tasks (local SQLite, skipped in Low RAM only)
        active_tasks = self.task.get_active_tasks()
        tasks_str = ""
        if active_tasks:
            tasks_str = "\n".join([f"- [Priority {t.priority}] {t.title}: {t.description}" for t in active_tasks])
        
        # 6. Build Injection Block
        injection_parts = []
        if pins_str:
            injection_parts.append(pins_str)
        if facts_str:
            injection_parts.append("### User Profile & Semantic Facts:\n" + facts_str)
        if episodes_str:
            injection_parts.append("### Relevant Past Episodes:\n" + episodes_str)
        if tasks_str:
            injection_parts.append("### Active Goals & Tasks:\n" + tasks_str)
            
        system_injection = "\n\n".join(injection_parts)
        
        # 7. Retrieve Working Memory Context
        base_context = self.working.get_context()
        augmented_context = []
        
        if system_injection:
            injected_msg = {
                "role": "system",
                "content": f"[SYSTEM INJECTION - MEMORY ROUTER]\n{system_injection}\n[END INJECTION]"
            }
            # Insert the injected context at the start or after an existing system prompt
            if base_context and base_context[0]["role"] == "system":
                augmented_context.append(base_context[0])
                augmented_context.append(injected_msg)
                augmented_context.extend(base_context[1:])
            else:
                augmented_context.append(injected_msg)
                augmented_context.extend(base_context)
        else:
            augmented_context = base_context
            
        return augmented_context

    def clear_session(self):
        """Clears the short-term working memory for this session."""
        self.working.clear()
        log.info(f"MemoryRouter [{self.session_id}]: Cleared working memory.")
