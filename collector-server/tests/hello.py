def hello():
    return "hello"


def add(a, b):
    return a + b


def multiply(a, b):
    return a * b


def divide(a, b):
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a / b


def sword_style():
    return "sword technique"
def run_all():


def molecular_weight(formula: str) -> float:
    """Compute approximate molecular weight for a chemical formula like H2O or C6H12O6.

    Supports element symbols with one uppercase letter or one uppercase + lowercase letter,
    and integer counts. Raises ValueError for unknown elements or malformed formulas.
    """
    ATOMIC_WEIGHTS = {
        "H": 1.008,
        "C": 12.011,
        "N": 14.007,
        "O": 15.999,
        "S": 32.06,
        "P": 30.974,
        "Cl": 35.45,
        "Na": 22.99,
        "K": 39.098,
        "Ca": 40.078,
        "Fe": 55.845,
    }

    i = 0
    total = 0.0
    length = len(formula)
    while i < length:
        ch = formula[i]
        if not ch.isupper():
            raise ValueError(f"Invalid formula at position {i}: '{ch}'")
        # parse element symbol
        elem = ch
        i += 1
        if i < length and formula[i].islower():
            elem += formula[i]
            i += 1

        # parse number (if any)
        num_start = i
        while i < length and formula[i].isdigit():
            i += 1
        count_str = formula[num_start:i]
        count = int(count_str) if count_str else 1

        if elem not in ATOMIC_WEIGHTS:
            raise ValueError(f"Unknown element: {elem}")
        total += ATOMIC_WEIGHTS[elem] * count

    return total


def run_all():
    results = {
        "hello": hello(),
        "add": add(2, 3),
        "multiply": multiply(2, 3),
        "divide": divide(6, 3),
        "sword_style": sword_style(),
        "mol_H2O": molecular_weight("H2O"),
        "mol_glucose": molecular_weight("C6H12O6"),
    }
    return results


if __name__ == "__main__":
    for name, value in run_all().items():
        print(f"{name}: {value}")
