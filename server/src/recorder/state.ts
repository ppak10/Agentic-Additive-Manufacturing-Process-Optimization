let buildId: number | null = null;

export function currentBuildId(): number | null {
  return buildId;
}

export function setCurrentBuildId(id: number | null): void {
  buildId = id;
}
