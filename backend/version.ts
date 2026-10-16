export const applicationVersion='0.15.0';

// Schema 1 only registers the existing layout and adds an index. The data is
// still readable by 0.14.17. Future migrations must explicitly reassess rollback.
export const releaseContract={
  version:applicationVersion,
  schemaVersion:1,
  upgradeFromSchemas:[0,1],
  rollbackToSchemas:[0,1],
};
