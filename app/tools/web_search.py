"""Web search tool — placeholder for search integration."""

from app.tools.registry import tool


@tool("Search the web for information. Returns relevant results for the given query.")
async def web_search(query: str, max_results: int = 3) -> str:
    """Search the web. Replace the body with your preferred search API."""
    import httpx

    # --- Replace with your actual search API ---
    # Example: DuckDuckGo Instant Answer API (free, no key needed)
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "https://api.duckduckgo.com/",
                params={"q": query, "format": "json", "no_html": 1},
                timeout=10,
            )
            data = resp.json()

            results = []
            if data.get("Abstract"):
                results.append(f"[Summary] {data['Abstract']}")
                results.append(f"Source: {data.get('AbstractURL', 'N/A')}")

            for topic in data.get("RelatedTopics", [])[:max_results]:
                if isinstance(topic, dict) and "Text" in topic:
                    results.append(f"- {topic['Text']}")
                    if "FirstURL" in topic:
                        results.append(f"  URL: {topic['FirstURL']}")

            if not results:
                return f"No results found for: {query}"
            return "\n".join(results)

    except Exception as e:
        return f"Search failed: {e}. Consider integrating a dedicated search API."
