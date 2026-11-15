import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
console.log('own keys:', Object.getOwnPropertyNames(h).join(', '));
console.log('proto:', Object.getOwnPropertyNames(Object.getPrototypeOf(h)).join(', '));
