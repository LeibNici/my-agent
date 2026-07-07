"""Skill system — pluggable skill modules that bundle tools + system prompt."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Skill:
    """A skill bundles related tools with a system prompt addition."""

    name: str
    description: str
    system_prompt: str
    tool_names: list[str] = field(default_factory=list)


# Global skill registry
_SKILLS: dict[str, Skill] = {}


def register_skill(skill: Skill):
    """Register a skill in the global registry."""
    _SKILLS[skill.name] = skill


def get_skill(name: str) -> Skill | None:
    return _SKILLS.get(name)


def list_skills() -> dict[str, Skill]:
    return dict(_SKILLS)


def build_system_prompt(
    base_prompt: str,
    active_skill_names: list[str],
) -> str:
    """Combine base system prompt with active skills' prompt additions."""
    parts = [base_prompt]
    for name in active_skill_names:
        skill = _SKILLS.get(name)
        if skill:
            parts.append(f"\n\n## Active Skill: {skill.name}\n{skill.system_prompt}")
    return "\n".join(parts)


def get_tools_for_skills(active_skill_names: list[str]) -> list[str]:
    """Return tool names that belong to the active skills."""
    tool_names = []
    for name in active_skill_names:
        skill = _SKILLS.get(name)
        if skill:
            tool_names.extend(skill.tool_names)
    return tool_names
