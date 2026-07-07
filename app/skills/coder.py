"""Coder skill — activates code-related tools."""

from app.skills.base import Skill, register_skill

register_skill(
    Skill(
        name="coder",
        description="Code assistant — can read files, run calculations, and help with programming tasks.",
        system_prompt=(
            "You are an expert programmer. When asked about code:\n"
            "- Use file_reader to examine existing code before making suggestions.\n"
            "- Use calculator for any numeric computations.\n"
            "- Provide clear, well-structured code with comments.\n"
            "- Explain your reasoning step by step."
        ),
        tool_names=["file_reader", "calculator"],
    )
)
