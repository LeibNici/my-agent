"""Calculator tool — evaluate math expressions."""

from app.tools.registry import tool


@tool("Evaluate a mathematical expression and return the result. Supports basic arithmetic, powers, and common math functions.")
def calculator(expression: str) -> str:
    """Evaluate a math expression like '2 + 3 * 4' or 'sqrt(16)'."""
    import math

    # Allow safe math operations
    allowed_names = {
        "abs": abs,
        "round": round,
        "min": min,
        "max": max,
        "sum": sum,
        "pow": pow,
        "sqrt": math.sqrt,
        "sin": math.sin,
        "cos": math.cos,
        "tan": math.tan,
        "log": math.log,
        "log10": math.log10,
        "pi": math.pi,
        "e": math.e,
    }

    result = eval(expression, {"__builtins__": {}}, allowed_names)
    return str(result)
