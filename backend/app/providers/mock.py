from app.models import RecommendationRequest, RecommendationResult


class MockRecommendationProvider:
    name = "mock"
    required_fields = ["hero_cards", "street"]

    def recommend(self, request: RecommendationRequest) -> RecommendationResult:
        state = request.state
        has_broadway = any(card.rank in {"A", "K", "Q", "J", "T"} for card in state.hero_cards)
        action = "raise" if has_broadway else "call"
        sizing = 7.5 if action == "raise" else None
        return RecommendationResult(
            action=action,
            sizing=sizing,
            confidence=0.72,
            explanation=(
                "Training recommendation from the mock provider: hero has strong high-card equity, "
                "so raising is preferred in this reviewed scenario."
            ),
            raw={
                "provider": self.name,
                "street": state.street,
                "hero_cards": [card.code for card in state.hero_cards],
            },
        )
