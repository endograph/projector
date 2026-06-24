const RESERVED_IDENTIFIER_PATTERN = /[:/]/;

export function assertProjectorIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be non-empty`);
  }
  if (RESERVED_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} cannot contain ":" or "/"`);
  }
}

export function assertProjectorIdentifiers(values: readonly string[], label: string): void {
  values.forEach((value, index) => {
    assertProjectorIdentifier(value, `${label}[${index}]`);
  });
}
