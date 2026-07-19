from app.providers.rule_based import RuleBasedTrainingProvider


class MockRecommendationProvider(RuleBasedTrainingProvider):
    name = "mock"
