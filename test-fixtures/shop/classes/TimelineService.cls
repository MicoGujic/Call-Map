public with sharing class TimelineService {
    /**
     * Returns the timeline records for one record.
     */
    @AuraEnabled
    public static TimelineResp getTimelineData(String confIdOrName, String recordId, String dateFilter) {
        TimelineResp resp = new TimelineResp();
        List<String> log = new List<String>();
        if (!areObjectAndFieldsAccessible()){
          log.add('Fields are not accessible');
          return resp;
        }
        // If we reached this far, we can query the configuration data
        Timeline_Configuration__c conf = getTimeLineConfigurationWithLines(confIdOrName);
	String soqlToExec = TimelineSOQLUtils.getSOQLForTimeline(conf, recordId,dateFilter,log);
        log.add(soqlToExec);
        return resp;
    }

    private static Boolean areObjectAndFieldsAccessible() {
        return Schema.sObjectType.Timeline_Configuration__c.isAccessible();
    }

    private static Timeline_Configuration__c getTimeLineConfigurationWithLines(String confIdOrName) {
        return [SELECT Id FROM Timeline_Configuration__c WHERE Name = :confIdOrName LIMIT 1];
    }
}
