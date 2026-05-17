"""
Working Memory (Layer 3 Component).
Handles short-term context window for AI agents. Features automatic token tracking
and summarization-based eviction to prevent context overflow.
"""

from typing import List, Dict, Optional, Any
import uuid
import datetime
from app.services.ollama import OllamaService
from app.utils.logger import get_logger

log = get_logger(__name__)

class WorkingMemory:
    """
    Short-term memory buffer representing the active context window of an agent.
    When the token limit is approached, it automatically summarizes older messages
    and truncates the buffer, yielding the summary for Episodic storage.
    """
    # Class-level cache mapping session_id -> {"messages": [...], "current_tokens": ...}
    _session_cache: Dict[str, Dict[str, Any]] = {}

    def __init__(self, session_id: Optional[str] = None, max_tokens: int = 4096):
        self.session_id = session_id or str(uuid.uuid4())
        self.max_tokens = max_tokens
        self.llm_service = OllamaService()
        
        # Initialize session in class-level cache if not present
        if self.session_id not in self._session_cache:
            self._session_cache[self.session_id] = {
                "messages": [],
                "current_tokens": 0
            }
        
        # We use a rough heuristic for token estimation without a heavy tokenizer:
        # 1 token ~= 4 characters in English
        self.CHARS_PER_TOKEN = 4

    @property
    def messages(self) -> List[Dict[str, str]]:
        return self._session_cache[self.session_id]["messages"]

    @messages.setter
    def messages(self, value: List[Dict[str, str]]):
        self._session_cache[self.session_id]["messages"] = value

    @property
    def current_tokens(self) -> int:
        return self._session_cache[self.session_id]["current_tokens"]

    @current_tokens.setter
    def current_tokens(self, value: int):
        self._session_cache[self.session_id]["current_tokens"] = value

    def _estimate_tokens(self, text: str) -> int:
        return len(text) // self.CHARS_PER_TOKEN

    async def add_message(self, role: str, content: str) -> Optional[str]:
        """
        Adds a message to the working memory.
        If the addition exceeds the token limit, it triggers a summarization 
        of the oldest half of the context.
        
        Returns:
            Optional[str]: A summary of evicted context if eviction occurred, else None.
        """
        message_tokens = self._estimate_tokens(content)
        
        # Check if we need to evict before adding
        evicted_summary = None
        if self.current_tokens + message_tokens > self.max_tokens:
            log.info(f"Session {self.session_id}: Token limit reached ({self.current_tokens}/{self.max_tokens}). Evicting context.")
            evicted_summary = await self._summarize_and_evict()

        message = {
            "role": role,
            "content": content,
            "timestamp": datetime.datetime.utcnow().isoformat()
        }
        self.messages.append(message)
        self.current_tokens += message_tokens
        
        return evicted_summary

    async def _summarize_and_evict(self) -> str:
        """
        Takes the oldest half of the conversation, generates a concise summary,
        retains the newer half, and prepends the summary as system context.
        """
        if not self.messages:
            return ""

        # Find the split point (evict older half)
        split_idx = max(1, len(self.messages) // 2)
        messages_to_evict = self.messages[:split_idx]
        messages_to_keep = self.messages[split_idx:]

        # Format evicted messages for summarization
        transcript = "\n".join([f"{m['role'].capitalize()}: {m['content']}" for m in messages_to_evict])
        
        prompt = (
            "Summarize the following conversation segment concisely. "
            "Focus on the main topics discussed, decisions made, and key facts.\n\n"
            f"Conversation:\n{transcript}"
        )

        log.debug(f"Session {self.session_id}: Summarizing {len(messages_to_evict)} messages...")
        
        try:
            summary = await self.llm_service.generate(prompt=prompt)
        except Exception as e:
            log.error(f"Failed to summarize context: {e}. Performing hard truncation.")
            summary = "Previous conversation context lost due to summarization failure."

        # Rebuild the buffer: System prompt (Summary) + Kept messages
        summary_message = {
            "role": "system",
            "content": f"Summary of earlier conversation: {summary}",
            "timestamp": datetime.datetime.utcnow().isoformat()
        }
        
        self.messages = [summary_message] + messages_to_keep
        
        # Recalculate token count
        self.current_tokens = sum(self._estimate_tokens(m['content']) for m in self.messages)
        
        return summary

    def get_context(self) -> List[Dict[str, str]]:
        """
        Returns the current active context window formatted for LLM ingestion.
        """
        return [{"role": m["role"], "content": m["content"]} for m in self.messages]

    async def get_summarized_context(self) -> List[Dict[str, str]]:
        """
        Generates a concise summary of the active working memory and returns it
        as a single system message, without altering or evicting the active messages.
        """
        if not self.messages:
            return []

        # If there's only one message, return it directly to save resources
        if len(self.messages) == 1:
            return [{"role": self.messages[0]["role"], "content": self.messages[0]["content"]}]

        # Format messages for the summarization prompt
        transcript = "\n".join([f"{m['role'].capitalize()}: {m['content']}" for m in self.messages])

        prompt = (
            "Summarize the following active conversation window concisely in a single paragraph. "
            "Highlight the ongoing topic and critical user details.\n\n"
            f"Conversation:\n{transcript}"
        )

        log.debug(f"Session {self.session_id}: Generating dynamic active context summary...")
        try:
            summary = await self.llm_service.generate(prompt=prompt)
        except Exception as e:
            log.error(f"Failed to generate dynamic context summary: {e}")
            summary = "Active conversation context truncated due to resource optimization."

        return [{
            "role": "system",
            "content": f"Summary of current active conversation: {summary}"
        }]
        
    def clear(self):
        """Wipes the working memory clean."""
        self.messages = []
        self.current_tokens = 0
