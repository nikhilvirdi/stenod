"""
Knowledge Agent (Layer 3 Component).
Specialized in factual and historical queries. Reads from episodic (vector DB) and semantic memory.
"""

from typing import Dict, Any, List
from app.services.ollama import OllamaService
from app.memory.router import MemoryRouter
from app.utils.logger import get_logger

log = get_logger(__name__)

class KnowledgeAgent:
    """
    Knowledge Agent retrieves personal semantic facts and past conversational episodes
    to handle queries demanding factual context or memory recall.
    """
    def __init__(self, memory_router: MemoryRouter):
        self.memory_router = memory_router
        self.llm = OllamaService()

    async def execute(self, query: str) -> str:
        log.info(f"KnowledgeAgent: Executing factual/historical query: '{query}'")
        
        # Compile augmented context from episodic, semantic, working memory, and pins
        context = await self.memory_router.get_augmented_context(query=query)
        
        # System directive instructing the LLM on its Knowledge Agent persona and data reliance
        system_directive = (
            "You are the Knowledge Agent of the Mnemosyne memory system.\n"
            "Your specialty is answering factual, historical, and personal profile queries.\n"
            "Analyze the provided 'User Profile & Semantic Facts' and 'Relevant Past Episodes' "
            "in the system injection block. Answer the user's questions based primarily on "
            "that memory. If the information is not found in memory, answer factual questions "
            "generally but politely note that the memory is empty or does not contain the specific fact."
        )
        
        # Inject persona constraints
        chat_messages = [{"role": "system", "content": system_directive}] + context
        
        try:
            response = await self.llm.chat(messages=chat_messages)
            log.debug("KnowledgeAgent: Successfully generated factual response.")
            return response
        except Exception as e:
            log.error(f"KnowledgeAgent: LLM execution failed: {e}")
            return "I encountered an issue accessing my memories to answer your query."
