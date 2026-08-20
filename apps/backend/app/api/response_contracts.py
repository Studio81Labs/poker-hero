"""OpenAPI response contracts shared by binary HTTP endpoints."""

from typing import Final

BinaryResponseSchema = dict[str, dict[str, dict[str, str]]]

BINARY_RESPONSE_SCHEMA: Final[BinaryResponseSchema] = {
    "schema": {"type": "string", "format": "binary"},
}
MARKDOWN_RESPONSE_SCHEMA: Final[dict[str, dict[str, str]]] = {
    "schema": {"type": "string"},
}
SUPPORTED_IMAGE_RESPONSE_CONTENT: Final[dict[str, BinaryResponseSchema]] = {
    "image/png": BINARY_RESPONSE_SCHEMA,
    "image/jpeg": BINARY_RESPONSE_SCHEMA,
    "image/gif": BINARY_RESPONSE_SCHEMA,
    "image/webp": BINARY_RESPONSE_SCHEMA,
}
ZIP_RESPONSE_CONTENT: Final[dict[str, BinaryResponseSchema]] = {
    "application/zip": BINARY_RESPONSE_SCHEMA,
}
MARKDOWN_RESPONSE_CONTENT: Final[dict[str, dict[str, dict[str, str]]]] = {
    "text/markdown": MARKDOWN_RESPONSE_SCHEMA,
}
