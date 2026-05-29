export {
  destroyPtySession,
  resizePty,
  subscribePty,
  unsubscribePty,
  writePtyInput,
} from "./registry.js";

export function ptyModuleLoaded(): boolean {
  return true;
}
