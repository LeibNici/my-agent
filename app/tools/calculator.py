"""Calculator tool — safely evaluate math expressions using AST parsing with resource limits."""

import ast
import math
import operator
import sys

from app.tools.registry import tool

# Resource limits
MAX_EXPRESSION_DEPTH = 50
MAX_EXPONENT = 10000
MAX_RESULT_DIGITS = 1000
MAX_LIST_SIZE = 1000

# Safe binary operators
_SAFE_BINOPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}

# Safe unary operators
_SAFE_UNARYOPS = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}

# Safe built-in functions
_SAFE_FUNCTIONS = {
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
    "int": int,
    "float": float,
}

# Safe constants
_SAFE_CONSTANTS = {
    "pi": math.pi,
    "e": math.e,
}


def _check_depth(node, depth=0):
    """Check expression tree depth doesn't exceed limit."""
    if depth > MAX_EXPRESSION_DEPTH:
        raise ValueError(f"Expression too complex (depth > {MAX_EXPRESSION_DEPTH})")
    for child in ast.iter_child_nodes(node):
        _check_depth(child, depth + 1)


def _bound_result(value):
    """Ensure result doesn't exceed size limits."""
    if isinstance(value, (int, float)):
        if isinstance(value, int) and value != 0:
            digits = len(str(abs(value)))
            if digits > MAX_RESULT_DIGITS:
                raise ValueError(f"Result too large ({digits} digits, max {MAX_RESULT_DIGITS})")
        if isinstance(value, float) and (math.isinf(value) or math.isnan(value)):
            raise ValueError("Result is infinity or NaN")
    return value


def _safe_eval_node(node, depth=0):
    """Recursively evaluate an AST node, allowing only safe operations."""
    if depth > MAX_EXPRESSION_DEPTH:
        raise ValueError(f"Expression too complex (depth > {MAX_EXPRESSION_DEPTH})")

    if isinstance(node, ast.Expression):
        return _safe_eval_node(node.body, depth)

    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float, complex)):
            return _bound_result(node.value)
        raise ValueError(f"Unsupported constant type: {type(node.value)}")

    if isinstance(node, ast.Name):
        if node.id in _SAFE_CONSTANTS:
            return _SAFE_CONSTANTS[node.id]
        raise ValueError(f"Unknown variable: {node.id}")

    if isinstance(node, ast.BinOp):
        op_type = type(node.op)
        if op_type not in _SAFE_BINOPS:
            raise ValueError(f"Unsupported operator: {op_type.__name__}")

        left = _safe_eval_node(node.left, depth + 1)
        right = _safe_eval_node(node.right, depth + 1)

        # Bound exponent for Pow operator
        if op_type is ast.Pow:
            if isinstance(right, (int, float)) and abs(right) > MAX_EXPONENT:
                raise ValueError(f"Exponent too large ({right}, max ±{MAX_EXPONENT})")
            if isinstance(left, (int, float)) and abs(left) > MAX_EXPONENT:
                raise ValueError(f"Base too large ({left}, max ±{MAX_EXPONENT})")

        result = _SAFE_BINOPS[op_type](left, right)
        return _bound_result(result)

    if isinstance(node, ast.UnaryOp):
        op_type = type(node.op)
        if op_type not in _SAFE_UNARYOPS:
            raise ValueError(f"Unsupported unary operator: {op_type.__name__}")
        result = _SAFE_UNARYOPS[op_type](_safe_eval_node(node.operand, depth + 1))
        return _bound_result(result)

    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name) and node.func.id in _SAFE_FUNCTIONS:
            func = _SAFE_FUNCTIONS[node.func.id]
            args = [_safe_eval_node(arg, depth + 1) for arg in node.args]
            if node.keywords:
                raise ValueError("Keyword arguments not supported")
            # Bound pow() function calls too
            if func is pow and len(args) == 2:
                if abs(args[1]) > MAX_EXPONENT:
                    raise ValueError(f"Exponent too large ({args[1]}, max ±{MAX_EXPONENT})")
            result = func(*args)
            return _bound_result(result)
        raise ValueError(f"Unknown function: {ast.dump(node.func)}")

    if isinstance(node, ast.List):
        if len(node.elts) > MAX_LIST_SIZE:
            raise ValueError(f"List too large ({len(node.elts)} elements, max {MAX_LIST_SIZE})")
        return [_safe_eval_node(elt, depth + 1) for elt in node.elts]

    if isinstance(node, ast.Tuple):
        if len(node.elts) > MAX_LIST_SIZE:
            raise ValueError(f"Tuple too large ({len(node.elts)} elements, max {MAX_LIST_SIZE})")
        return tuple(_safe_eval_node(elt, depth + 1) for elt in node.elts)

    raise ValueError(f"Unsupported expression: {ast.dump(node)}")


@tool("Evaluate a mathematical expression and return the result. Supports basic arithmetic, powers, and common math functions.")
def calculator(expression: str) -> str:
    """Evaluate a math expression like '2 + 3 * 4' or 'sqrt(16)'."""
    # Input length limit
    if len(expression) > 500:
        return f"Error: Expression too long ({len(expression)} chars, max 500)"

    try:
        tree = ast.parse(expression, mode="eval")
        _check_depth(tree)
        result = _safe_eval_node(tree)
        # Format large numbers in scientific notation
        if isinstance(result, int) and abs(result) > 1e15:
            return f"{result:.6e}"
        return str(result)
    except Exception as e:
        return f"Error: {e}"
