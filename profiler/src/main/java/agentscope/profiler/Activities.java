package agentscope.profiler;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Names what a stack is doing, from the ordered rules in activities.txt. */
public final class Activities {
  private record Rule(Pattern pattern, String label) {}

  private static final List<Rule> RULES = load();
  private static final Pattern JDK = Pattern.compile("^(java|javax|jdk|sun|com\\.sun)\\.");
  // a Java "package.Class.method" frame; native, kernel and stub frames (JFR's or async-profiler's) don't look like this
  private static final Pattern JAVA = Pattern.compile("^[\\w$]+(\\.[\\w$<>]+)+$");

  private static List<Rule> load() {
    List<Rule> rules = new ArrayList<>();
    try (BufferedReader r = new BufferedReader(new InputStreamReader(Activities.class.getResourceAsStream("/activities.txt"), StandardCharsets.UTF_8))) {
      for (String line; (line = r.readLine()) != null; ) {
        if (line.isBlank() || line.startsWith("#")) continue;
        String[] f = line.split("\t+", 2);
        rules.add(new Rule(Pattern.compile(f[0]), f[1].strip()));
      }
    } catch (Exception e) {
      throw new IllegalStateException("activities.txt", e);
    }
    return rules;
  }

  /** @param frames root first */
  public static String classify(List<String> frames) {
    for (Rule rule : RULES) {
      for (int i = frames.size() - 1; i >= 0; i--) {  // leaf first: the most specific frame names a captured group
        Matcher m = rule.pattern().matcher(frames.get(i));
        if (m.find()) return m.groupCount() > 0 && m.group(1) != null ? rule.label().replace("$1", m.group(1).toLowerCase(Locale.ROOT)) : rule.label();
      }
    }
    boolean java = false;
    for (int i = frames.size() - 1; i >= 0; i--) {  // the top Java frame outside the JDK, by package
      String f = frames.get(i);
      if (!JAVA.matcher(f).matches()) continue;
      java = true;
      if (JDK.matcher(f).find()) continue;
      // its package: the segments before the class name (which starts upper case), at most three deep
      String[] parts = f.split("\\.");
      StringBuilder pkg = new StringBuilder();
      for (int k = 0; k < Math.min(3, parts.length - 2) && !parts[k].isEmpty() && Character.isLowerCase(parts[k].charAt(0)); k++)
        pkg.append(k == 0 ? "" : ".").append(parts[k]);
      return pkg.isEmpty() ? parts[0] : pkg.toString();
    }
    return java ? "JDK" : "native";
  }

  /** Thread names with their numbering wildcarded, as the page does: pool-3-thread-12 -> pool-*-thread-*. */
  public static String threadGroup(String name) {
    return name == null ? "?" : name.replaceAll("(?<=[-#_ .])\\d+|(?<=[a-zA-Z])\\d+$", "*");
  }
}
