"""
Semantic Memory (Layer 3 Component).
Uses advanced LLM inference to extract structured facts and preferences
from unstructured dialogue and persists them to the SQL database.
"""

import json
from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session
from app.db.models import SemanticMemory as SemanticMemoryModel
from app.services.ollama import OllamaService
from app.utils.logger import get_logger

log = get_logger(__name__)

class SemanticMemoryManager:
    """
    Manages the extraction and CRUD operations for long-term semantic facts.
    """
    def __init__(self, db_session: Session):
        self.db = db_session
        self.llm = OllamaService()

    async def extract_and_store(self, text: str) -> List[Dict[str, Any]]:
        """
        Analyzes unstructured text to extract user preferences or facts.
        If facts are found, they are upserted into the SQLite database.
        Returns the list of extracted facts.
        """
        prompt = (
            "Analyze the following conversation text and extract any explicit or implicit "
            "facts, preferences, or entity information about the user.\n"
            "Respond ONLY with a valid JSON array of objects. Do not include markdown code blocks or conversational text.\n"
            "Each object must have exactly these three string keys: "
            "'key' (a short snake_case identifier like 'prefers_dark_mode'), "
            "'value' (the actual fact), and 'category' (one of 'preference', 'fact', 'entity').\n"
            "If no facts are present, return an empty array [].\n\n"
            f"Text:\n{text}"
        )

        try:
            response = await self.llm.generate(prompt=prompt)
            # Clean up potential markdown formatting from LLM
            clean_response = response.strip()
            if clean_response.startswith("```json"):
                clean_response = clean_response[7:]
            if clean_response.startswith("```"):
                clean_response = clean_response[3:]
            if clean_response.endswith("```"):
                clean_response = clean_response[:-3]
                
            extracted_facts = json.loads(clean_response)
            
            if not isinstance(extracted_facts, list):
                log.warning("LLM did not return a JSON array for semantic extraction.")
                return []

            saved_facts = []
            for fact in extracted_facts:
                if "key" in fact and "value" in fact and "category" in fact:
                    self._upsert_fact(
                        key=fact["key"], 
                        value=fact["value"], 
                        category=fact["category"]
                    )
                    saved_facts.append(fact)
            
            return saved_facts

        except json.JSONDecodeError as e:
            log.error(f"Failed to parse JSON from LLM extraction: {e} | Raw: {response}")
            return []
        except Exception as e:
            log.error(f"Error during semantic extraction: {e}")
            return []

    def _upsert_fact(self, key: str, value: str, category: str):
        """
        Inserts a new fact or checks for conflict and queues it if contradictory.
        """
        from app.memory.conflict import ConflictDetector
        detector = ConflictDetector(self.db)
        
        conflict = detector.check_and_register_conflict(category, key, value)
        if conflict:
            log.info(f"Fact '{key}' = '{value}' has a registered conflict. Skipping immediate overwrite.")
            return

        existing_fact = self.db.query(SemanticMemoryModel).filter(SemanticMemoryModel.key == key).first()
        
        if existing_fact:
            existing_fact.value = value
            existing_fact.category = category
            log.debug(f"Updated semantic fact: {key} = {value}")
        else:
            new_fact = SemanticMemoryModel(
                key=key,
                value=value,
                category=category,
                confidence=0.9  # Initial confidence for LLM extracted facts
            )
            self.db.add(new_fact)
            log.debug(f"Inserted new semantic fact: {key} = {value}")
            
        self.db.commit()

    def get_all_facts(self) -> List[Dict[str, Any]]:
        """
        Retrieves all semantic facts to build the global user context profile.
        """
        facts = self.db.query(SemanticMemoryModel).all()
        return [
            {
                "key": f.key, 
                "value": f.value, 
                "category": f.category, 
                "confidence": f.confidence
            } 
            for f in facts
        ]
        
    def get_facts_by_category(self, category: str) -> List[Dict[str, Any]]:
        """
        Retrieves semantic facts filtered by category.
        """
        facts = self.db.query(SemanticMemoryModel).filter(SemanticMemoryModel.category == category).all()
        return [
            {
                "key": f.key, 
                "value": f.value, 
                "confidence": f.confidence
            } 
            for f in facts
        ]
