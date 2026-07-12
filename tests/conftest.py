"""Make the scripts/ directory importable as plain modules for tests."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
