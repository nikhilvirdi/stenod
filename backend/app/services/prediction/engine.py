"""
Prediction Engine Service.
Wraps the PyTorch LSTM to provide high-level predictions for the Adaptive Memory Manager.
"""
import os
import torch
import numpy as np
from typing import List, Dict, Tuple
from app.config import get_settings
from app.utils.logger import get_logger
from app.services.prediction.model import ContextLSTM

log = get_logger(__name__)

class PredictionEngine:
    """
    Service to manage the LSTM prediction lifecycle: loading weights, feature extraction, and inference.
    """
    def __init__(self, seq_length: int = 5):
        self.settings = get_settings()
        self.seq_length = seq_length
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
        # Configuration for the model
        # In a real scenario, these would be loaded from a config or the model checkpoint
        self.app_vocab: Dict[str, int] = {"<PAD>": 0, "<UNKNOWN>": 1}
        self.reverse_vocab: Dict[int, str] = {0: "<PAD>", 1: "<UNKNOWN>"}
        
        # Will initialize model lazily or load from path
        self.model = None
        self._load_or_init_model()

    def _load_or_init_model(self):
        """Loads model weights if available, else initializes a fresh model."""
        # For this phase, we initialize a placeholder model if no checkpoint exists.
        # Dimensions based on Android Usage Patterns assumptions
        self.num_apps = max(100, len(self.app_vocab)) 
        self.app_embed_dim = 16
        self.num_continuous_features = 6  # hour_sin, hour_cos, day_sin, day_cos, battery, charging
        self.hidden_dim = 64
        
        self.model = ContextLSTM(
            num_apps=self.num_apps,
            app_embed_dim=self.app_embed_dim,
            num_continuous_features=self.num_continuous_features,
            hidden_dim=self.hidden_dim
        ).to(self.device)
        
        model_path = self.settings.PREDICTION_MODEL_PATH
        if os.path.exists(model_path):
            try:
                # Assuming the checkpoint contains the model state and the vocabulary
                checkpoint = torch.load(model_path, map_location=self.device)
                self.model.load_state_dict(checkpoint['model_state_dict'])
                self.app_vocab = checkpoint.get('app_vocab', self.app_vocab)
                self.reverse_vocab = {v: k for k, v in self.app_vocab.items()}
                self.model.eval()
                log.info(f"Loaded prediction model from {model_path}")
            except Exception as e:
                log.error(f"Failed to load model from {model_path}: {e}. Using untrained model.")
        else:
            log.warning(f"No model found at {model_path}. Using uninitialized model. Predictions will be random until trained.")
            self.model.eval()

    def _extract_features(self, context_seq: List[Dict]) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        Converts a list of context dictionaries into PyTorch tensors.
        Handles padding if the sequence is shorter than seq_length.
        """
        app_indices = []
        cont_features = []
        
        # Pad sequence if necessary
        padded_seq = context_seq.copy()
        while len(padded_seq) < self.seq_length:
            padded_seq.insert(0, {
                "app": "<PAD>", "hour": 0, "day": 0, "battery": 0.0, "charging": False
            })
            
        # Ensure we don't exceed seq_length (take the most recent)
        padded_seq = padded_seq[-self.seq_length:]
            
        for ctx in padded_seq:
            app = ctx.get("app", "<UNKNOWN>")
            app_idx = self.app_vocab.get(app, self.app_vocab["<UNKNOWN>"])
            app_indices.append(app_idx)
            
            # Continuous features mapping (cyclical encoding for time)
            hour = ctx.get("hour", 0)
            day = ctx.get("day", 0)
            hour_sin = np.sin(2 * np.pi * hour / 24.0)
            hour_cos = np.cos(2 * np.pi * hour / 24.0)
            day_sin = np.sin(2 * np.pi * day / 7.0)
            day_cos = np.cos(2 * np.pi * day / 7.0)
            battery = ctx.get("battery", 0.0) / 100.0
            charging = 1.0 if ctx.get("charging", False) else 0.0
            
            cont_features.append([hour_sin, hour_cos, day_sin, day_cos, battery, charging])
            
        app_tensor = torch.tensor([app_indices], dtype=torch.long).to(self.device)
        cont_tensor = torch.tensor([cont_features], dtype=torch.float32).to(self.device)
        
        return app_tensor, cont_tensor

    def predict_next_app(self, recent_contexts: List[Dict]) -> Tuple[str, float]:
        """
        Predicts the next application based on a sequence of recent contexts.
        Returns a tuple of (predicted_app_name, confidence_score).
        Target KPI: >= 75% accuracy.
        """
        if not recent_contexts:
            return "<UNKNOWN>", 0.0
            
        app_tensor, cont_tensor = self._extract_features(recent_contexts)
        
        with torch.no_grad():
            logits = self.model(app_tensor, cont_tensor)
            probabilities = torch.softmax(logits, dim=1)
            
            # Get the highest probability class
            max_prob, max_idx = torch.max(probabilities, dim=1)
            
            pred_idx = max_idx.item()
            confidence = max_prob.item()
            
            predicted_app = self.reverse_vocab.get(pred_idx, "<UNKNOWN>")
            
            log.debug(f"Predicted {predicted_app} with {confidence:.2f} confidence.")
            return predicted_app, confidence
