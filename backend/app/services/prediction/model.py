"""
PyTorch LSTM model for predicting the user's next application/context.
Trained on Android Usage Patterns dataset.
"""

import torch
import torch.nn as nn

class ContextLSTM(nn.Module):
    """
    LSTM architecture for sequential context prediction.
    Takes a sequence of past contexts (app + continuous features) and predicts the next app.
    """
    def __init__(self, num_apps: int, app_embed_dim: int, num_continuous_features: int, hidden_dim: int, num_layers: int = 2):
        super(ContextLSTM, self).__init__()
        self.hidden_dim = hidden_dim
        self.num_layers = num_layers
        
        # Categorical embedding for application IDs
        self.app_embedding = nn.Embedding(num_embeddings=num_apps, embedding_dim=app_embed_dim)
        
        # The input to LSTM will be the concatenation of the app embedding and the continuous features
        input_size = app_embed_dim + num_continuous_features
        
        # We use dropout if num_layers > 1
        dropout = 0.2 if num_layers > 1 else 0.0
        self.lstm = nn.LSTM(input_size, hidden_dim, num_layers, batch_first=True, dropout=dropout)
        
        # Output layer maps the hidden state back to the probability distribution over all apps
        self.fc = nn.Linear(hidden_dim, num_apps)
        
    def forward(self, app_seq, cont_seq):
        """
        Args:
            app_seq: Tensor of shape (batch_size, seq_length) containing application integer indices.
            cont_seq: Tensor of shape (batch_size, seq_length, num_continuous_features) containing features like time, battery.
        Returns:
            Logits for the next application of shape (batch_size, num_apps).
        """
        # 1. Embed the application indices
        app_embedded = self.app_embedding(app_seq) 
        
        # 2. Concatenate app embeddings with continuous features along the feature dimension
        combined_input = torch.cat((app_embedded, cont_seq), dim=2) 
        
        # 3. Pass through LSTM
        lstm_out, _ = self.lstm(combined_input)
        
        # 4. Extract the output from the final time step in the sequence
        last_time_step_out = lstm_out[:, -1, :]
        
        # 5. Generate logits for the next app
        out = self.fc(last_time_step_out)
        
        return out
