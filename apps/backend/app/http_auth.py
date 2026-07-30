from pydantic import SecretStr


def bearer_headers(token: SecretStr | None) -> dict[str, str]:
    if token is None:
        return {}
    return {"Authorization": f"Bearer {token.get_secret_value()}"}
