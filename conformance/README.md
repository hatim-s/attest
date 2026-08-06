# Conformance fixtures

Each contract has its own fixture directory: `config`, `trace`, `agent`, or `metric`. A fixture is
an input-and-expected pair named `NN-description.{json,yaml}`. These fixtures are the compatibility
gate for contract changes and are shared by packages. `fake-agents/` holds hostile agent
executables used to harden the runner.
