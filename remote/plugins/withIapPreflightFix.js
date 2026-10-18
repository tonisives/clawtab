let { withPodfile } = require("expo/config-plugins")

let addIosDeploymentTargetPatch = (podfile) => {
  let marker = "# ClawTab: align pod deployment targets with the app"
  if (podfile.includes(marker)) return podfile
  let anchor = "post_install do |installer|"
  if (!podfile.includes(anchor)) throw new Error("iOS deployment target fix: CocoaPods post_install hook not found")
  return podfile.replace(anchor, `${anchor}
    ${marker}
    minimum_ios_version = podfile_properties['ios.deploymentTarget'] || '16.4'
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_configuration|
        configured_target = build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if configured_target.nil? || Gem::Version.new(configured_target) < Gem::Version.new(minimum_ios_version)
          build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum_ios_version
        end
      end
    end
`)
}

let addIapPreflightPatch = (podfile) => {
  let marker = "# ClawTab: patch the native StoreKit preflight timeout"
  if (podfile.includes(marker)) return podfile
  let anchor = "post_install do |installer|"
  if (!podfile.includes(anchor)) throw new Error("IAP preflight fix: CocoaPods post_install hook not found")
  return podfile.replace(anchor, `${anchor}
    ${marker}
    patch_script = File.join(__dir__, '..', 'plugins', 'patch-iap-preflight.js')
    unless system('node', patch_script, installer.sandbox.root.to_s)
      raise 'IAP preflight fix failed; refusing to build an unpatched purchase flow'
    end
`)
}

module.exports = (config) => withPodfile(config, (config) => {
  config.modResults.contents = addIosDeploymentTargetPatch(addIapPreflightPatch(config.modResults.contents))
  return config
})
module.exports.addIosDeploymentTargetPatch = addIosDeploymentTargetPatch
module.exports.addIapPreflightPatch = addIapPreflightPatch
