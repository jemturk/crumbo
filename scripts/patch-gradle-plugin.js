const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '../node_modules/@react-native/gradle-plugin/settings.gradle.kts');

if (fs.existsSync(targetFile)) {
  let content = fs.readFileSync(targetFile, 'utf8');
  // Match id("org.gradle.toolchains.foojay-resolver-convention").version("...")
  const regex = /id\("org\.gradle\.toolchains\.foojay-resolver-convention"\)\.version\("[^"]+"\)/;
  if (regex.test(content)) {
    content = content.replace(regex, 'id("org.gradle.toolchains.foojay-resolver-convention").version("1.0.0")');
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log('Successfully patched @react-native/gradle-plugin settings.gradle.kts to use foojay-resolver-convention version 1.0.0.');
  } else {
    console.log('foojay-resolver-convention version config not found.');
  }
} else {
  console.log('File not found to patch:', targetFile);
}
