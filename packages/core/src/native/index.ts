import { installVendorResolver } from "./resolver.js";

installVendorResolver();

export { checkNativeModules, type NativeCheckResult } from "./check.js";
export {
  exportTarget,
  installVendorResolver,
  loadPackage,
  resolveVendorEntry,
  usesVendorModules,
  vendorNodeModulesDir,
} from "./resolver.js";
