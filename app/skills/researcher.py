"""Researcher skill — activates search and reading tools."""

from app.skills.base import Skill, register_skill

register_skill(
    Skill(
        name="researcher",
        description="Research assistant — can search the web and read files to gather information.",
        system_prompt=(
            "You are a thorough researcher. When asked a question:\n"
            "- Use web_search to find relevant information from the internet.\n"
            "- Use file_reader to examine local documents when needed.\n"
            "- Synthesize information from multiple sources.\n"
            "- Always cite your sources.\n"
            "- If information conflicts, present multiple perspectives."
        ),
        tool_names=["web_search", "file_reader", "calculator"],
    )
)
