import type { ComponentType } from 'react';
import type { WorkflowRendererProps } from './types';

const registry = new Map<string, ComponentType<WorkflowRendererProps>>();

export function registerRenderer(name: string, comp: ComponentType<WorkflowRendererProps>): void {
  registry.set(name, comp);
}

export function getRenderer(name: string): ComponentType<WorkflowRendererProps> | undefined {
  return registry.get(name);
}
