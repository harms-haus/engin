export type RenderFunction = (data: unknown) => string;

export class RendererRegistry {
  private renderers = new Map<string, RenderFunction>();

  register(profileName: string, fn: RenderFunction): void {
    this.renderers.set(profileName, fn);
  }

  get(profileName: string): RenderFunction | undefined {
    return this.renderers.get(profileName);
  }

  render(profileName: string, data: unknown): string | undefined {
    const fn = this.get(profileName);
    if (fn) {
      return fn(data);
    }
    return undefined;
  }
}
