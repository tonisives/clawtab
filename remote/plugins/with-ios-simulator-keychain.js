const {
  IOSConfig,
  withPodfile,
  withXcodeProject,
} = require("expo/config-plugins");

const ENTITLEMENTS_SETTING = '"ENTITLEMENTS_ALLOWED[sdk=iphonesimulator*]"';
const MODULAR_HEADERS_MARKER = "# ClawTab: Google Sign-In Swift dependencies";
const PODFILE_MARKER = "# ClawTab: align pod deployment targets for Xcode 27";

function withSimulatorEntitlements(config) {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const appTarget = IOSConfig.XcodeUtils.getApplicationNativeTarget({
      project,
      projectName: config.modRequest.projectName,
    });
    const configurations = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
      project,
      appTarget.target.buildConfigurationList,
    );

    for (const [, buildConfiguration] of configurations) {
      buildConfiguration.buildSettings[ENTITLEMENTS_SETTING] = "YES";
    }

    return config;
  });
}

function withSupportedPodDeploymentTargets(config) {
  return withPodfile(config, (config) => {
    if (!config.modResults.contents.includes(MODULAR_HEADERS_MARKER)) {
      const expoModules = "  use_expo_modules!";
      const googleDependencies = `${expoModules}
  ${MODULAR_HEADERS_MARKER}
  pod 'GoogleUtilities', :modular_headers => true
  pod 'RecaptchaInterop', :modular_headers => true`;

      if (!config.modResults.contents.includes(expoModules)) {
        throw new Error("Could not find use_expo_modules! in the Podfile");
      }

      config.modResults.contents = config.modResults.contents.replace(
        expoModules,
        googleDependencies,
      );
    }

    if (config.modResults.contents.includes(PODFILE_MARKER)) {
      return config;
    }

    const postInstall = "  post_install do |installer|";
    const deploymentTargetFix = `${postInstall}
    ${PODFILE_MARKER}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_configuration|
        build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] =
          podfile_properties['ios.deploymentTarget'] || '16.4'
      end
    end`;

    if (!config.modResults.contents.includes(postInstall)) {
      throw new Error("Could not find the Podfile post_install block");
    }

    config.modResults.contents = config.modResults.contents.replace(
      postInstall,
      deploymentTargetFix,
    );
    return config;
  });
}

module.exports = function withIosSimulatorKeychain(config) {
  config = withSimulatorEntitlements(config);
  config = withSupportedPodDeploymentTargets(config);
  return config;
};
