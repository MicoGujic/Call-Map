public with sharing class TimelineSOQLUtils {
    /** Builds the SOQL query for a timeline configuration. Adds steps to the log. */
    public static String getSOQLForTimeline(Timeline_Configuration__c conf, String recordId, String dateFilter, List<String> log) {
        log.add('building');
        return 'SELECT Id FROM ' + conf.Name;
    }
}
