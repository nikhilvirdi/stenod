"""
Scheduler Agent (Layer 3 Component).
Specialized in scheduling and time-based tasks; reads and writes task memory.
"""

import json
from typing import Dict, Any, List, Optional
from app.services.ollama import OllamaService
from app.memory.router import MemoryRouter
from app.utils.logger import get_logger

log = get_logger(__name__)

class SchedulerAgent:
    """
    Scheduler Agent handles goal planning, scheduling, and task state tracking.
    Extracts structured intent from user requests and interacts directly with TaskManager.
    """
    def __init__(self, memory_router: MemoryRouter):
        self.memory_router = memory_router
        self.llm = OllamaService()

    async def execute(self, query: str) -> str:
        log.info(f"SchedulerAgent: Executing task management/scheduling query: '{query}'")
        
        # 1. Ask LLM to extract structured task instruction
        extraction_prompt = (
            "Analyze the following user query and determine if they want to manage scheduling, tasks, or goals.\n"
            "Respond with ONLY a valid JSON object. Do not include markdown code blocks (like ```json) or any other text.\n"
            "The JSON object must have exactly these keys:\n"
            "- 'action': Must be one of 'create_task', 'update_status', 'list_tasks', or 'none'.\n"
            "- 'title': The title of the task to create, or null.\n"
            "- 'description': Description of the task, or null.\n"
            "- 'priority': Integer priority score (default 0), or null.\n"
            "- 'parent_id': Integer parent task ID (for subtasks), or null.\n"
            "- 'task_id': Integer ID of the task to update status for, or null.\n"
            "- 'status': The new status (one of 'pending', 'in_progress', 'completed', 'failed'), or null.\n\n"
            f"Query: {query}"
        )
        
        action = "none"
        action_details = {}
        try:
            raw_response = await self.llm.generate(prompt=extraction_prompt)
            clean_resp = raw_response.strip()
            if clean_resp.startswith("```json"):
                clean_resp = clean_resp[7:]
            if clean_resp.startswith("```"):
                clean_resp = clean_resp[3:]
            if clean_resp.endswith("```"):
                clean_resp = clean_resp[:-3]
            
            parsed = json.loads(clean_resp.strip())
            action = parsed.get("action", "none")
            action_details = parsed
            log.debug(f"SchedulerAgent: Extracted action '{action}' | details: {action_details}")
        except Exception as e:
            log.warning(f"SchedulerAgent: Failed to parse structured action JSON: {e}")
            action = "none"

        # 2. Execute structured database changes
        action_feedback = ""
        task_manager = self.memory_router.task
        
        if action == "create_task":
            title = action_details.get("title")
            desc = action_details.get("description") or ""
            priority = action_details.get("priority") or 0
            parent_id = action_details.get("parent_id")
            
            if title:
                new_task = task_manager.create_task(
                    title=title,
                    description=desc,
                    priority=priority,
                    parent_id=parent_id
                )
                action_feedback = f"[SYSTEM NOTIFICATION: Successfully created task '{new_task.title}' with ID {new_task.id} (status: pending, priority: {new_task.priority}).]"
            else:
                action_feedback = "[SYSTEM ERROR: Tried to create a task but title was missing.]"
                
        elif action == "update_status":
            task_id = action_details.get("task_id")
            status = action_details.get("status")
            
            if task_id is not None and status:
                success = task_manager.update_status(task_id=task_id, status=status)
                if success:
                    action_feedback = f"[SYSTEM NOTIFICATION: Updated task {task_id} status to '{status}'.]"
                else:
                    action_feedback = f"[SYSTEM ERROR: Task {task_id} not found.]"
            else:
                action_feedback = "[SYSTEM ERROR: Missing task_id or status for update.]"
                
        elif action == "list_tasks":
            active = task_manager.get_active_tasks()
            if active:
                tasks_list = "\n".join([f"- ID {t.id} | [Priority {t.priority}] {t.title}: {t.description} (status: {t.status})" for t in active])
                action_feedback = f"[SYSTEM NOTIFICATION: Active tasks stored in database:\n{tasks_list}]"
            else:
                action_feedback = "[SYSTEM NOTIFICATION: There are no active tasks in the database.]"

        # 3. Assemble context and generate chat completion
        context = await self.memory_router.get_augmented_context(query=query)
        
        # Inject the action feedback to the top of context so the LLM is aware of DB execution
        system_directive = (
            "You are the Scheduler Agent of the Mnemosyne memory system.\n"
            "Your specialty is managing schedules, goals, and tasks.\n"
            "Below is the feedback from executing the user's task instruction.\n"
            "Communicate this outcome to the user gracefully. Review the 'Active Goals & Tasks' "
            "to give them context about their outstanding schedule.\n\n"
            f"Execution Results:\n{action_feedback}"
        )
        
        chat_messages = [{"role": "system", "content": system_directive}] + context
        
        try:
            response = await self.llm.chat(messages=chat_messages)
            return response
        except Exception as e:
            log.error(f"SchedulerAgent: Chat generation failed: {e}")
            return f"I performed the task action, but failed to generate a chat response: {action_feedback}"
