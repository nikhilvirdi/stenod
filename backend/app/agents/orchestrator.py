"""
Orchestrator Agent (Layer 3 Component).
Uses a lightweight custom StateGraph architecture to classify user intent,
route state conditional transitions, and coordinate specialized agents.
"""

from typing import Dict, Any, List, Optional, Callable
from sqlalchemy.orm import Session

from app.memory.router import MemoryRouter
from app.agents.knowledge import KnowledgeAgent
from app.agents.scheduler import SchedulerAgent
from app.services.ollama import OllamaService
from app.utils.logger import get_logger

log = get_logger(__name__)

# --- Lightweight StateGraph Implementation ---

class CompiledGraph:
    """
    Executable runtime compiled from a StateGraph.
    Flows state through nodes and handles conditional edge transitions.
    """
    def __init__(self, graph: "StateGraph"):
        self.nodes = graph.nodes
        self.edges = graph.edges
        self.conditional_edges = graph.conditional_edges
        self.entry_point = graph.entry_point

    async def ainvoke(self, initial_state: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes the state machine asynchronously starting from the entry point.
        """
        if not self.entry_point:
            raise ValueError("StateGraph compiled without an entry point set.")

        state = dict(initial_state)
        current_node = self.entry_point

        log.info(f"StateGraph: Starting execution at entry point '{current_node}'")

        while current_node and current_node != "__end__":
            # 1. Execute current node's logic
            node_fn = self.nodes.get(current_node)
            if not node_fn:
                raise KeyError(f"Node '{current_node}' was defined but is missing an action function.")
            
            log.debug(f"StateGraph: Executing node '{current_node}'")
            state = await node_fn(state)

            # 2. Check for conditional transitions out of this node
            if current_node in self.conditional_edges:
                route_fn, path_map = self.conditional_edges[current_node]
                log.debug(f"StateGraph: Running conditional router for node '{current_node}'")
                decision = await route_fn(state)
                next_node = path_map.get(decision)
                
                if not next_node:
                    log.warning(f"StateGraph: Router returned path '{decision}' which does not map to a destination node. Ending execution.")
                    current_node = "__end__"
                else:
                    current_node = next_node
                continue

            # 3. Check for standard static transitions out of this node
            next_node = self.edges.get(current_node)
            if next_node:
                current_node = next_node
            else:
                # No more edges, terminate
                log.debug(f"StateGraph: No outgoing transitions for node '{current_node}'. Terminating.")
                current_node = "__end__"

        log.info("StateGraph: Execution successfully completed.")
        return state


class StateGraph:
    """
    A lightweight, dependency-free representation of a LangGraph-style workflow.
    """
    def __init__(self):
        self.nodes: Dict[str, Callable] = {}
        self.edges: Dict[str, str] = {}
        self.conditional_edges: Dict[str, tuple] = {}
        self.entry_point: Optional[str] = None

    def add_node(self, name: str, action_func: Callable) -> None:
        self.nodes[name] = action_func

    def add_edge(self, source: str, destination: str) -> None:
        self.edges[source] = destination

    def add_conditional_edges(self, source: str, path_func: Callable, path_map: Dict[str, str]) -> None:
        self.conditional_edges[source] = (path_func, path_map)

    def set_entry_point(self, name: str) -> None:
        self.entry_point = name

    def compile(self) -> CompiledGraph:
        return CompiledGraph(self)


# --- Orchestrator Implementation ---

class Orchestrator:
    """
    The orchestrator compiles the StateGraph routing architecture and acts as the single endpoint 
    for processing chatbot and multi-agent interactions.
    """
    def __init__(self, db_session: Session, session_id: Optional[str] = None):
        self.db = db_session
        self.memory_router = MemoryRouter(db_session, session_id=session_id)
        self.session_id = self.memory_router.session_id
        
        self.llm = OllamaService()
        self.scheduler_agent = SchedulerAgent(self.memory_router)
        self.knowledge_agent = KnowledgeAgent(self.memory_router)
        
        # Build the graph
        self.graph = self._build_graph()

    def _build_graph(self) -> CompiledGraph:
        """
        Builds and compiles the multi-agent routing graph.
        """
        builder = StateGraph()

        # Add Nodes
        builder.add_node("intent_classifier", self._intent_classifier_node)
        builder.add_node("scheduler_agent", self._scheduler_agent_node)
        builder.add_node("knowledge_agent", self._knowledge_agent_node)
        builder.add_node("chat_agent", self._chat_agent_node)

        # Set entry point
        builder.set_entry_point("intent_classifier")

        # Define conditional routing out of intent classifier
        builder.add_conditional_edges(
            source="intent_classifier",
            path_func=self._router_decision_func,
            path_map={
                "scheduling": "scheduler_agent",
                "knowledge": "knowledge_agent",
                "chat": "chat_agent"
            }
        )

        return builder.compile()

    # --- Node Action Definitions ---

    async def _intent_classifier_node(self, state: Dict[str, Any]) -> Dict[str, Any]:
        """
        LLM intent classification node. Matches the query to correct specialty category.
        """
        query = state["query"]
        classification_prompt = (
            "You are the central intent classifier of the Mnemosyne memory OS.\n"
            "Analyze the following user query and determine which downstream agent should handle it.\n\n"
            "Categories:\n"
            "- 'scheduling': Select this if the user wants to create a task, update a task, view goals, check schedules, or plan events.\n"
            "- 'knowledge': Select this if the user wants to query facts, recall past events/episodes, check personal preferences, or search details from profile memory.\n"
            "- 'chat': Select this for general chit-chat, greetings, conversational questions, or unspecified prompts.\n\n"
            f"Query: {query}\n\n"
            "Respond with exactly one of the three lowercase category words ('scheduling', 'knowledge', 'chat') and absolutely nothing else."
        )

        try:
            raw_class = await self.llm.generate(prompt=classification_prompt)
            classification = raw_class.strip().lower()
            # Clean up punctuation/markdown
            classification = "".join([c for c in classification if c.isalnum()])
            if classification not in ["scheduling", "knowledge", "chat"]:
                log.warning(f"Orchestrator: Invalid classification '{classification}' returned. Defaulting to 'chat'.")
                classification = "chat"
        except Exception as e:
            log.error(f"Orchestrator: LLM classification failed: {e}. Defaulting to 'chat'.")
            classification = "chat"

        state["classification"] = classification
        log.info(f"Orchestrator: Classified intent as '{classification}'")
        return state

    async def _scheduler_agent_node(self, state: Dict[str, Any]) -> Dict[str, Any]:
        """
        Scheduler Node delegates to SchedulerAgent.
        """
        query = state["query"]
        response = await self.scheduler_agent.execute(query)
        state["response"] = response
        return state

    async def _knowledge_agent_node(self, state: Dict[str, Any]) -> Dict[str, Any]:
        """
        Knowledge Node delegates to KnowledgeAgent.
        """
        query = state["query"]
        response = await self.knowledge_agent.execute(query)
        state["response"] = response
        return state

    async def _chat_agent_node(self, state: Dict[str, Any]) -> Dict[str, Any]:
        """
        Standard Conversational Fallback chat agent.
        """
        query = state["query"]
        context = await self.memory_router.get_augmented_context(query)
        
        system_directive = (
            "You are the Mnemosyne Assistant, a persistent, context-aware memory system.\n"
            "Engage in conversational chat based on the injected context records where relevant."
        )
        
        chat_messages = [{"role": "system", "content": system_directive}] + context
        
        try:
            response = await self.llm.chat(messages=chat_messages)
        except Exception as e:
            log.error(f"Orchestrator: Fallback chat execution failed: {e}")
            response = "I encountered an error trying to process your request."
            
        state["response"] = response
        return state

    async def _router_decision_func(self, state: Dict[str, Any]) -> str:
        """
        Returns the router transition key.
        """
        return state.get("classification", "chat")

    # --- Public API Interface ---

    async def handle_message(self, message: str) -> Dict[str, Any]:
        """
        Public entry point. Feeds user input into MemoryRouter,
        executes the orchestrator graph, and commits response to MemoryRouter.
        """
        log.info(f"Orchestrator [{self.session_id}]: Handling new message: '{message}'")
        
        # 1. Update Short-Term & Semantic Memory with User Input
        await self.memory_router.route_input("user", message)

        # 2. Execute Multi-Agent Graph
        initial_state = {
            "query": message,
            "response": "",
            "classification": "",
            "session_id": self.session_id
        }
        
        final_state = await self.graph.ainvoke(initial_state)
        response = final_state.get("response", "I could not formulate an answer.")

        # 3. Update Short-Term Memory with Assistant Response
        await self.memory_router.route_input("assistant", response)

        return {
            "response": response,
            "classification": final_state.get("classification", "chat"),
            "session_id": self.session_id
        }
