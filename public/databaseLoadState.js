export function createDatabaseLoadGuard(createController = () => new AbortController()) {
  let requestId = 0;
  let active = null;

  return {
    begin(selection = {}) {
      active?.controller.abort();
      active = {
        id: ++requestId,
        selection: { ...selection },
        controller: createController(),
      };
      return active;
    },
    invalidate() {
      active?.controller.abort();
      requestId += 1;
      active = null;
    },
    isCurrent(load) {
      return Boolean(load) && active === load && load.id === requestId;
    },
    finish(load) {
      if (!this.isCurrent(load)) return false;
      active = null;
      return true;
    },
  };
}
