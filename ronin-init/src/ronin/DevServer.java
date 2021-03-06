package ronin;

import gw.lang.parser.GosuParserFactory;
import gw.lang.parser.exceptions.ParseResultsException;
import gw.lang.parser.template.ITemplateGenerator;
import gw.lang.reflect.IType;
import gw.lang.reflect.TypeSystem;
import gw.lang.reflect.gs.IGosuClass;
import gw.lang.reflect.gs.ITemplateType;
import gw.lang.Gosu;
import gw.util.GosuClassUtil;
import gw.util.Pair;
import jline.Terminal;
import org.apache.commons.io.FileUtils;
import org.apache.commons.io.FilenameUtils;
import org.apache.commons.io.filefilter.SuffixFileFilter;
import org.apache.commons.io.filefilter.TrueFileFilter;
import org.apache.commons.io.output.NullOutputStream;
import org.apache.sshd.ClientChannel;
import org.apache.sshd.ClientSession;
import org.apache.sshd.SshClient;
import org.apache.sshd.common.util.NoCloseInputStream;
import org.apache.sshd.common.util.NoCloseOutputStream;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.webapp.WebAppContext;
import org.h2.server.web.WebServer;
import org.junit.runner.Result;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.*;

public class DevServer {
  private static String h2WebURL;

  public static void main(String[] args) throws Exception {

    if (System.getProperty("ronin.mode") == null) {
      System.setProperty("ronin.mode", "dev");
    }
    if (args.length == 0) 
    {
      args = new String[]{"server", "8080", "."};
    }
    if ("server".equals(args[0]) || "server-nodb".equals(args[0])) {
      log("Environment properties are: " + new RoninServletWrapper().getEnvironmentProperties(new File(args[2])));

      if ("dev".equals(System.getProperty("ronin.mode"))) {
        if (!RoninServletWrapper.isDCEVMAvailable()) {
          LoggerFactory.getLogger("Ronin").warn("The DCEVM is not available, Ronin will use classloaders for hotswapping");
        }
      }

      int port = Integer.parseInt(args[1]);
      String root = args[2];      
      if ("server".equals(args[0])) {
        startH2(args[2]);
      }
      startJetty(port, root);
      log("");
      log("Your Ronin App is listening at http://localhost:8080");
    } else if ("upgrade_db".equals(args[0])) {
      resetDb(args[1]);
    } else if ("verify_ronin_app".equals(args[0])) {
      File root = new File(args[1]);
      log("Verifying app...");
      log("Environment properties are: " + new RoninServletWrapper().getEnvironmentProperties(root));
      if (!verifyApp(root)) {
        System.exit(-1);
      } else {
        log("No errors found.");
      }
    } else if ("test".equals(args[0])) {
      System.setProperty("ronin.mode", "test");
      resetDb(args[1]);
      File root = new File(args[1]);
      initGosu(root);
      TestScanner scanner = new TestScanner(new File(root, "test"));
      log("Running tests...");
      log("Environment properties are: " + new RoninServletWrapper().getEnvironmentProperties(root));
      Result result = scanner.runTests(Boolean.valueOf(args[2]), Boolean.valueOf(args[3]));
      System.exit(result.wasSuccessful() ? 0 : -1);
    } else if ("uiTest".equals(args[0])) {
      System.setProperty("ronin.mode", "test");
      int port = Integer.parseInt(args[1]);
      System.setProperty("ronin.test.port", String.valueOf(port));
      String root = args[2];
      resetDb(root);
      startJetty(port, root);
      if ("server".equals(args[0])) {
        startH2(args[2]);
      }
      TestScanner scanner = new TestScanner(new File(root, "test"));
      log("Running tests...");
      log("Environment properties are: " + new RoninServletWrapper().getEnvironmentProperties(new File(root)));
      Result result = scanner.runUITests(Boolean.valueOf(args[3]), Boolean.valueOf(args[4]));
      System.exit(result.wasSuccessful() ? 0 : -1);
    } else if ("console".equals(args[0])) {
      PrintStream oldErr = System.err;
      System.setErr(new PrintStream(new NullOutputStream()));
      SshClient ssh;
      try {
        ssh = SshClient.setUpDefaultClient();
      } finally {
        System.setErr(oldErr);
      }
      ssh.start();
      try {
        ClientSession session = ssh.connect("localhost", Integer.parseInt(args[1])).await().getSession();
        session.authPassword(args[2], args[3]);
        int ret = session.waitFor(ClientSession.WAIT_AUTH | ClientSession.CLOSED | ClientSession.AUTHED, 0);
        if ((ret & ClientSession.CLOSED) != 0) {
          System.err.println("Error connecting to admin console.");
          System.exit(-1);
        }
        ClientChannel channel = session.createChannel("shell");
        Terminal.setupTerminal();
        channel.setIn(new NoCloseInputStream(new FileInputStream(FileDescriptor.in)));
        channel.setOut(new NoCloseOutputStream(System.out));
        channel.setErr(new NoCloseOutputStream(System.err));
        channel.open();
        channel.waitFor(ClientChannel.CLOSED, 0);
        session.close(true);
      } finally {
        ssh.stop();
      }
    } else {
      throw new IllegalArgumentException("Do not understand command " + Arrays.toString(args));
    }
  }

  private static void startH2(String root) throws SQLException, IOException {
    List<Pair<String, org.h2.tools.Server>> h2Servers = startH2(root, false);

    //===================================================================================
    //  Start H2 web
    //===================================================================================
    int webPort = 8082;
    for (Pair<String, org.h2.tools.Server> h2Server : h2Servers) {
      org.h2.tools.Server h2WebServer = org.h2.tools.Server.createWebServer(h2Server.getSecond().getURL(), "-webPort", Integer.toString(webPort));
      webPort++;
      h2WebServer.start();
      String h2URL = h2Server.getFirst();
      h2WebURL = ((WebServer) h2WebServer.getService()).addSession(DriverManager.getConnection(h2URL));
      log("H2 web console started at " + h2WebURL);
      log("\nYou can connect to your database using \"" + h2URL + "\" as your url, and a blank username/password.");
    }
  }

  private static void startJetty(int port, String root) throws Exception {
    Server jettyServer = new Server(port);
    File webRoot = new File(root, "html");
    jettyServer.setHandler(new WebAppContext(webRoot.toURI().toURL().toExternalForm(), "/"));
    jettyServer.start();
  }

  private static void resetDb(String arg) throws SQLException, IOException {
    List<Pair<String, org.h2.tools.Server>> h2Servers = startH2(arg, true);
    for (Pair<String, org.h2.tools.Server> h2Server : h2Servers) {
      h2Server.getSecond().stop();
    }
  }

  private static void initGosu(File root) {
    new RoninServletWrapper().initGosu(root, true);
  }

  public static String getH2WebURL() {
    return h2WebURL;
  }

  private static boolean verifyApp(File root) {
    boolean errorsFound = false;
    int typesVerified = 0;
    PrintStream oldErr = System.err;
    System.setErr(new PrintStream(new NullOutputStream()));
    StringBuilder output = new StringBuilder();
    try {
      initGosu(root);
      TreeSet<String> appTypes = new TreeSet<String>();
      findTypesToVerify(new File("src"), new File("src"), appTypes);
      findTypesToVerify(new File("test"), new File("test"), appTypes);
      for (CharSequence name : appTypes) {
        System.out.println("Verifying " + name);
        IType type = TypeSystem.getByFullNameIfValid(name.toString());
        if (type != null) {
          errorsFound = errorsFound || verifyType(output, type);
          typesVerified++;
        }
      }
    } finally {
      System.setErr(oldErr);
    }
    log(output.toString());
    log(typesVerified + " types verified.");
    return !errorsFound;
  }

  private static void findTypesToVerify(File root, File file, Set<String> appTypes) {
    String ext = GosuClassUtil.getFileExtension(file);
    if (".gs".equals(ext) || ".gsx".equals(ext) || ".gst".equals(ext)) {
      String filePath = file.getAbsolutePath();
      String rootPath = root.getAbsolutePath();
      String typeName = filePath.substring(rootPath.length() + 1, filePath.lastIndexOf('.'));
      typeName = typeName.replace(File.separatorChar, '.');
      appTypes.add(typeName);
    } else if (file.isDirectory()) {
      for (File child : file.listFiles()) {
        findTypesToVerify(root, child, appTypes);
      }
    }
  }

  private static boolean verifyType(StringBuilder output, IType type) {
    if (type instanceof IGosuClass) {
      boolean valid = type.isValid();
      if (!valid) {
        output.append("Errors in ").append(type.getName()).append(":\n");
        output.append(indentString(((IGosuClass) type).getParseResultsException().getFeedback())).append("\n");
        return true;
      }
    } else if (type instanceof ITemplateType) {
      if (!type.isValid()) {
        output.append("Errors in ").append(type.getName()).append(":\n");
        ITemplateGenerator generator = ((ITemplateType) type).getTemplateGenerator();
        try {
          generator.verify(GosuParserFactory.createParser(null));
        } catch (ParseResultsException e) {
          output.append(indentString(e.getFeedback())).append("\n");
        }
        return true;
      }
    } else {
      if (!type.isValid()) {
        output.append("Errors in ").append(type.getName()).append("\n");
      }
    }
    return false;
  }

  private static String indentString(String feedback) {
    StringBuilder indentedContent = new StringBuilder();
    String[] lines = feedback.split("\n");
    for (String line : lines) {
      indentedContent.append("  ").append(line);
      indentedContent.append("\n");
    }
    return indentedContent.toString();
  }

  private static List<File> makeClasspathFromSystemClasspath() {
    ArrayList<File> files = new ArrayList<File>();
    for (String path : System.getProperty("java.class.path").split(File.pathSeparator)) {
      files.add(new File(path));
    }
    return files;
  }

  public static void initGosuWithSystemClasspath() {
    Gosu.init(makeClasspathFromSystemClasspath());
  }

  private static List<Pair<String, org.h2.tools.Server>> startH2(String root, boolean forceInit) throws SQLException, IOException {
    List<Pair<String, org.h2.tools.Server>> h2Servers = new ArrayList<Pair<String, org.h2.tools.Server>>();
    List<String> h2URLs = getH2URLs(root);
    int port = 9092;
    for (String h2URL : h2URLs) {
      org.h2.tools.Server h2Server = org.h2.tools.Server.createTcpServer(h2URL + ";TRACE_LEVEL_SYSTEM_OUT=3", "-tcpPort", Integer.toString(port));
      port++;
      h2Server.start();

      log("H2 DB started at " + h2URL + " STATUS:" + h2Server.getStatus());

      Connection conn = DriverManager.getConnection(h2URL);
      Statement stmt = conn.createStatement();
      if (forceInit) {
        log("Dropping all user tables");
        stmt.execute("DROP ALL OBJECTS");
        log("Dropped all user tables");
      }
      if (forceInit || !isInited(conn)) {
        File dbRoot = new File(root, "src" + File.separator + "db");
        Iterator iter = FileUtils.iterateFiles(dbRoot, new SuffixFileFilter(".ddl"), TrueFileFilter.INSTANCE);
        if (iter.hasNext()) {
          File file = (File) iter.next();
          if (file.exists()) {
            String sql = FileUtils.readFileToString(file);
            log("Creating DB from " + file.getAbsolutePath());
            stmt.execute(sql);
            log("Done");
          } else {
            log("Could not find an initial schema at " + file.getAbsolutePath() + ".  The database will be empty initially.");
          }
          stmt.execute("CREATE TABLE ronin_metadata (name varchar(256), value varchar(256))");
        }
      }
      conn.close();
      h2Servers.add(Pair.make(h2URL, h2Server));
    }
    return h2Servers;
  }

  private static String getMode() {
    String mode = System.getProperty("ronin.mode");
    if (mode == null) {
      mode = "dev";
    }
    return mode;
  }
    
  public static String getDefaultTestURL() {
    return "jdbc:h2:file:runtime/h2/testdb";
  }

  private static List<String> getH2URLs(String root) {
    if ("test".equals(System.getProperty("ronin.mode"))) {
      return Arrays.asList(getDefaultTestURL());
    }
    if ("staging".equals(System.getProperty("ronin.mode"))) {
      return Arrays.asList("jdbc:h2:file:runtime/h2/stagingdb");
    }
    if ("prod".equals(System.getProperty("ronin.mode"))) {
      return Arrays.asList("jdbc:h2:file:runtime/h2/proddb");
    }
    return Arrays.asList("jdbc:h2:file:runtime/h2/devdb");
  }

  private static boolean isInited(Connection conn) throws SQLException {
    ResultSet tables = conn.getMetaData().getTables(null, null, null, null);
    while (tables.next()) {
      if (tables.getString("TABLE_NAME").equalsIgnoreCase("ronin_metadata")) {
        return true;
      }
    }
    return false;
  }

  private static void log(String s) {
    LoggerFactory.getLogger("Ronin").info(s);
  }
}
